# Sprint Plan - 1.1.0 Sprint 1

| Field | Value |
| --- | --- |
| Status | Implemented 2026-11-13; unreleased, listed under [Unreleased](../CHANGELOG.md#unreleased) |
| Window | 2026-11-13 to 2026-11-26 (two weeks) |
| Milestone | 1.1.0 - Performance and housekeeping |
| Base | 1.0.0 (`d5c2798`) |
| Items | PERF-01, PERF-02, PERF-03, PERF-04, DEP-01 |

## Sprint Goal

Keep the 1.0 vault fast and bounded as it grows. Remove the per-row database queries from list
endpoints, stop the webhook history from growing forever, stop searches from waiting on an
unreachable Ollama, and bring dependencies up to date without changing behavior.

This sprint adds no feature that needs a live provider, a phone, or signing keys. It changes no
table shape, and every existing route keeps its contract.

## Why This Scope Next

- Every 1.0 roadmap item is implemented. What is left in the
  [1.0.0 status](../ROADMAP.md#100-status) is evidence only the owner can produce, so it cannot be
  planned as engineering work.
- REL-08 sets list and search budgets for a 10,000-recording library. A sweep of the code found
  list endpoints that ran one query per row (up to 1,000 per mobile sync page). Those undermine
  the budget before it is measured on the reference Mac.
- The implementation notes listed unbounded growth (webhook history) and a 5-second wait per
  search when Ollama is stopped. Both are small, local, and testable.

## Outcome

| ID | Result | Evidence |
| --- | --- | --- |
| PERF-01 | Done. N+1 queries removed from: mobile change feed (`ChangeFeed.changes`, up to 1,000 queries per page down to 3), task drafts list and `.ics` calendar, automation run history (2N+1 down to 2), webhook deliveries list (N+1 down to 2), batch cost estimate (one query for up to 500 recordings), retrieved-passage origins in chat, and the Plaud device-recordings lookup (a `Map` instead of a scan per session) | Query-count regression tests that compare 1 row with 12-50 rows: `src/api/mobile.test.ts`, `src/automation/tasks.test.ts`, `src/automation/rules.test.ts`, `src/automation/webhooks.test.ts`, `src/ai/spending.test.ts`; helper `src/testing/count-queries.ts` |
| PERF-02 | Done. Webhook delivery history retention: finished deliveries older than 90 days are pruned with their attempts every six hours. Pending and in-flight deliveries are never touched. The event row stays as the idempotency record with its payload cleared | `src/automation/webhooks.test.ts` (only finished and old rows go; a re-emitted pruned event is not delivered again; a second run prunes nothing) |
| PERF-03 | Done. The installed-Ollama-model check used by search is cached per fetcher: 30 s when Ollama answers, 15 s when it does not. Settings > "Load local models" still asks Ollama directly | `src/knowledge/retrieval.test.ts` (one call while cached, unreachable result cached, refresh after expiry) |
| PERF-04 | Done. `PATCH /api/settings` saves several legacy settings in one transaction. The Settings page sent about ten parallel `PUT`s and could leave a half-saved state on a partial failure; it now sends one request that applies completely or not at all | Typecheck; manual check against a temporary vault (valid batch saved, a batch with one unknown key rejected with nothing written, `PUT /api/settings/:key` unchanged) |
| DEP-01 | Done. Every backend, web and Rust dependency updated within its semver range. `drizzle-orm` 0.38 to 0.45 and `drizzle-kit` 0.30 to 0.31. Rust lockfiles refreshed for the desktop app and `plaud-bridge` | 601 backend tests, `tsc --noEmit`, web lint and build, `cargo check` for both crates |

## Decisions

- **Pruned events keep their id.** Event ids are derived from the event type and subject, and
  `INSERT OR IGNORE` is what stops a duplicate delivery. Deleting the event row would let a
  replayed event go out again after 90 days, so only its payload is cleared.
- **The Ollama cache is short and keyed by fetcher.** Tests and callers that inject their own
  fetcher never share a cached answer. The cache only affects the search path; the settings route
  that lists models is uncached so a person who just ran `ollama pull` sees the model at once.
- **`eslint-plugin-react-hooks` stays at 7.0.1.** 7.1 adds React Compiler rules that report 24
  new errors (mostly `set-state-in-effect`). Fixing those is UI refactoring with no user-facing
  change, so it is a separate ticket rather than part of a dependency refresh.
- **Major upgrades that change APIs are deferred:** TypeScript 7, Vite 8, `@vitejs/plugin-react`
  6, ESLint 10, React Router 7, wavesurfer.js 8, `@deepgram/sdk` 5, and `@hono/node-server` 2
  (unused by the server; it can be removed). Each needs its own migration and UI check.

## Not Claimed

- **Markdown export lookups.** Each exported note with a source recording still runs up to four
  lookups (cached per source). It is a background, user-started action; folding the lookups into
  the page query is the next step.
- **Trash purge.** Expired recordings are purged one transaction each, repeating schema checks per
  recording. This is a background task; the per-recording transaction is deliberate.
- **The REL-08 reference-Mac benchmark** is still to be run. The query counts above are fixed per
  page, but no new latency number is claimed here.
- **`sync_changes` compaction**, the native Android outbox screen, and a per-client permission
  editor remain open from the [mobile notes](impl-notes/stream-e-mobile.md#not-done-leftovers).

## Definition of Done

- Merged implementation with automated tests, `bun run typecheck`, and frontend lint/build passing.
- No table changes shape; no existing route changes its response.
- `docs/api.md`, `docs/automation.md`, README, ROADMAP, and CHANGELOG updated.

## Next Sprint Candidates

1. React Compiler lint rules: fix the 24 `react-hooks` findings, then lift the 7.0.1 pin.
2. Markdown export: fold source and version lookups into the page query.
3. `sync_changes` compaction with a documented cursor-expiry rule (`410` already exists).
4. Per-client permission toggles on the Android page (the API and web client already exist).
5. Major upgrades one at a time, starting with React Router 7 and Vite 8.
