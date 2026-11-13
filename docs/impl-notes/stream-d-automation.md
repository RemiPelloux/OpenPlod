# Stream D: webhooks, rules, and reviewed task exports (KB-08, KB-09, KB-10)

Implementation notes for the automation stream. The code lives in `src/automation/` and the
`Automations` page (`web/src/pages/AutomationsPage.tsx`, route `/automations`). Edits to shared
files are limited to small event hooks and route mounting.

## Product rules and how they are enforced

| Rule | Mechanism |
| --- | --- |
| No automatic external posting from transcript content | Rules are data the user wrote; transcript text is never parsed for instructions. Task exports run only from an explicit `POST .../tasks/export` with `confirm: true`. Nothing is scheduled. |
| Transcript text never grants permission | Event payloads contain ids and metadata. Text is included only on webhooks with `includeText`, which needs a separate `acknowledgeText: true`. |
| Cloud consent and local-only mode cannot be bypassed | Rules store acknowledgements (`audio:<provider>`, `text:<provider>`, `webhook:<host>`). Enabling needs every non-local requirement acknowledged, and each step re-checks the acknowledgement and local-only mode **when it runs**, so changing AI settings later blocks the step instead of silently sending. The existing job handler still calls `assertPrivacy`. In local-only mode, webhooks to non-loopback URLs are recorded as `blocked`, and connector exports are refused. |
| Retries never duplicate downstream writes | Stable ids (`stableId()` in `common.ts`, SHA-256 based, UUID-shaped). Webhook events: `(type, subject)`. Deliveries: `(event, subscription)`. Rule runs: `(rule, recording)`. Rule steps: `(rule, recording, step index)`, used as the document-generation idempotency key and the notify-event subject. Task exports: `(task, connector)`, claimed before the network call, with the remote id stored afterwards. |
| Uncertain delivery is `unknown`, not success | Timeouts, resets, and anything other than a provable connect/DNS failure are `unknown`. Webhook `unknown` deliveries are not retried automatically. A task export with an `unknown` outcome (or a 5xx response) is resent only with `retryUnknown: true`, which the UI asks for separately. A process that stops mid-request marks the in-flight attempt `unknown` on the next start. |

## KB-08: signed webhook events

Tables (created with `CREATE TABLE IF NOT EXISTS`, additive): `webhook_subscriptions`,
`webhook_events` (the outbox), `webhook_deliveries`, `webhook_attempts`.

- **Events:** `recording.imported`, `recording.transcribed`, `document.created`, `job.failed`.
  Internal targeted types: `webhook.test` (ping) and `automation.notify` (rule step).
- **Hooks** (`src/automation/hooks.ts`, an in-process bus that does nothing until `startAutomation` registers listeners):
  - `src/library/processing.ts`: `recording.imported` at the start of `queueRecordingProcessing`, which every import path calls. It is awaited so a rule's transcription choice is queued before the default auto-transcription (the queue then deduplicates per recording).
  - `src/index.ts`: `recording.transcribed` after `saveGeneratedTranscript`, with the transcript version id (= job id).
  - `src/organizer/store.ts`: `document.created` inside the `create` transaction, so the outbox row commits or rolls back with the document.
  - `src/jobs/queue.ts`: `job.failed` after a handler failure is persisted. Cancellations are not failures.
- **Subscriptions:** HTTPS, or plain HTTP to `localhost`/`127.0.0.1`/`[::1]`; no URL credentials or fragments. An external URL needs `acknowledgeExternal: true`. The secret (`whsec_` + 32 random bytes) is generated server-side and returned only from create and `rotate-secret`.
- **Delivery:** `POST` with `redirect: 'error'` and a 10 s timeout. Headers: `OpenPlod-Signature`, `OpenPlod-Event-Id`, `OpenPlod-Delivery-Id`, `OpenPlod-Event-Type`, and `Idempotency-Key` (= event id). Body: `{ schemaVersion: "1", id, type, createdAt, deliveryId, data }`. Response bodies are never stored.
- **Retries:** non-2xx responses and refused connections retry with exponential backoff (30 s × 2^(n−1), capped at 1 h), up to 6 attempts. The delivery is then `failed`. After 5 failed deliveries in a row, the subscription is disabled with a reason; re-enabling it resets the counter. Every attempt (auto or manual, outcome, status code, duration) is kept in `webhook_attempts`.
- **Redelivery** (`POST /api/v1/webhooks/deliveries/:id/redeliver`) adds a manual attempt to the same delivery, reusing the event and delivery ids.
- **Worker:** started after each enqueue (after the transaction commits) and every 15 s from `startAutomation`.

### Signature verification

`OpenPlod-Signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map(part => part.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
}
// Deduplicate on OpenPlod-Event-Id: retries and redeliveries reuse it.
```

### API (`/api/v1/webhooks`)

`GET /` · `POST /` · `GET|PATCH|DELETE /:id` · `POST /:id/rotate-secret` · `POST /:id/test` ·
`GET /:id/deliveries` · `GET /deliveries/:deliveryId` · `POST /deliveries/:deliveryId/redeliver`.

## KB-09: opt-in rules

Tables: `automation_rules`, `automation_runs` (unique per rule and recording; the run stores a
snapshot of the actions), `automation_run_steps` (per-step status, detail, result reference,
attempt count).

- **Trigger:** `recording.imported` with optional filters: `sources` (`plaud` = source provider
  Plaud, `upload`, `mobile` = mobile transport), `recordingTypes`, `tag`, and
  `minDurationSeconds`. An unknown duration never satisfies a minimum.
- **Actions, in order:** `transcribe` (provider and/or profile; rules disable provider fallback so
  only the approved provider is used), `generate_document` (template and folder; uses
  `DocumentGenerationService` with the step id as the idempotency key, then `save`),
  `add_tags`, `add_to_collection`, `notify_webhook`.
- **Waiting:** `transcribe` queues a `process-recording` job and waits. The step completes when
  a transcript version with the job id exists. The run continues on `recording.transcribed`,
  `job.failed`, or the 15 s sweep, which also covers restarts. `generate_document` waits for an
  active transcription job, or fails if there is no transcript and no job.
- **Preview** (`POST /rules/preview`, `GET /rules/:id/preview`): matching existing recordings
  (first 25, plus a total over the latest 2,000), every provider or host that would receive audio,
  text, or metadata with today's settings, missing acknowledgements, what local-only mode
  blocks, and `estimatedCost: { status: 'unknown', amount: null }`. Rules do not run
  retroactively.
- **Kill switch:** disabling or deleting a rule makes its pending and waiting steps `skipped`
  and the run `cancelled`. History is kept.
- **Retry** (`POST /runs/:id/retry`): resets failed, unknown, and skipped steps. A retried
  generation uses a fresh key derived from the step id and attempt number. Completed steps are
  never repeated.
- **Crash safety:** steps left `running` return to `pending` at startup. Every step is
  idempotent by its id. An interrupted generation shows as `unknown`, because the provider may
  have billed it.

### API (`/api/v1/automations`)

`GET /catalog` · `GET|POST /rules` · `POST /rules/preview` · `GET|PATCH|DELETE /rules/:id` (PATCH
needs `revision`) · `GET /rules/:id/preview` · `GET /rules/:id/runs` · `GET /runs` ·
`GET /runs/:id` · `POST /runs/:id/retry`.

## KB-10: reviewed task exports

Tables: `task_drafts` (with a unique `source_ref` so importing the same action items again
never duplicates them) and `task_exports` (unique per task and connector, storing the remote
id and URL).

- **Drafts:** `POST /tasks/extract { recordingId, items? }` takes the supplied items (for
  example, TS-06 structure action items the client just showed) or the saved analysis
  `transcripts.extracted_tasks`. Spoken due dates ("next Friday") stay in `dueText`; only an
  explicit `YYYY-MM-DD` becomes `dueDate`. Tasks can also be added by hand.
- **Review:** each task is edited and approved one by one. Editing an approved task returns it to
  `draft`. A task that was exported (or may have been) cannot be deleted, only dismissed.
- **Export** (`POST /tasks/export { connector, taskIds, confirm: true, retryUnknown? }`):
  only approved tasks are sent.
  - **Todoist:** REST v2 `POST /rest/v2/tasks` with `X-Request-Id` = export id.
  - **Linear:** GraphQL `issueCreate` with `teamId`.
  - **Notion:** `POST /v1/pages` into a database, with a configurable title property and an
    optional date property, using `Notion-Version: 2022-06-28`.
  - **Outcomes:** 2xx with an id is `created`; 4xx and refused connections are `failed`
    (retryable); 5xx, timeouts, and a 2xx without an id are `unknown`.
- **Calendar:** `GET /tasks/calendar.ics?ids=` returns an iCalendar file with one all-day
  `VEVENT` per dated task, generated locally.
- **Credentials** are stored in `user_settings` like the other keys: `todoistApiToken`,
  `linearApiKey`, `linearTeamId`, `notionApiKey`, `notionDatabaseId`,
  `notionTitleProperty`, and `notionDateProperty`. `GET /tasks/connectors` reports only
  whether each connector is configured.

## Tests

The tests are `src/automation/webhooks.test.ts`, `rules.test.ts`, `tasks.test.ts`, and
`web/src/lib/automation-api.test.ts`. They use in-memory SQLite and injected fetchers, with no
network access. They cover: signature verification, stable ids, outbox deduplication, backoff,
max attempts, auto-disable, `unknown` on timeout, redelivery reusing ids, crash recovery,
local-only blocking, text opt-in, rule acknowledgement gating, run-time consent re-checks, step
idempotency across repeated events and sweeps, the retry key for generation, the kill switch,
previews, export-once semantics, `unknown` export handling, connector request shapes, and
iCalendar escaping.

## Known gaps and leftovers

- **Recording collections** do not exist in this branch. `add_to_collection` is accepted and
  recorded as `skipped`. Once a collections API lands, pass `addToCollection` to `RuleEngine`
  in `src/automation/index.ts`.
- **Duration filter:** `minDurationSeconds` uses the duration stored at import. Some import
  paths only fill it after transcription, so those recordings do not match a minimum.
- **Webhook retention:** resolved in [1.1.0 Sprint 1](../sprint-1.1.0-1.md): finished deliveries
  older than 90 days are pruned with their attempts; event rows stay as the idempotency record.
- **Live connectors:** the Todoist, Linear, and Notion adapters are contract-tested with
  injected fetchers only. Live acceptance, OAuth, and Linear due-date permissions per workspace
  were not verified.
- **Docs:** `docs/api.md` and `docs/mcp.md` were not updated, to avoid conflicts with
  parallel streams. The endpoints above should be folded into `docs/api.md` on merge. No MCP
  tools were added for automation.
- **Concurrency:** rule execution runs inside the server process with an in-memory guard per
  run. The idempotency keys still keep a second process from duplicating writes.
