# OpenPlod API

AI provider settings, connection checks, spending estimates, and durable job controls are described in [AI Settings, Spending, and Cost Confirmation](#ai-settings-spending-and-cost-confirmation) and in [ai-providers.md](ai-providers.md#apis). Automation (webhooks, rules, reviewed tasks) and mobile sync have their own sections below and user guides in [automation.md](automation.md) and [mobile-sync.md](mobile-sync.md). Every route uses the same authentication. Provider adapters are contract-tested against recorded request and response shapes; live provider acceptance remains an open release gate.

The organizer API is rooted at `/api/v1`. It runs inside the existing desktop service, normally `http://127.0.0.1:3487`. Existing recording and transcript endpoints remain backward compatible.

## Authentication and Exposure

Send `X-OpenPlod-Token` with the desktop pairing token, a separately configured `OPENPLOD_API_TOKEN`, or a paired phone's own device token. The native app automatically configures its pairing token. A source-run server with neither token configured remains unauthenticated for local development; do not bind it to a shared network in that state.

Tokens are credentials, not public URLs. Keep them out of query strings, logs, source, and screenshots. The native app uses private-LAN HTTP for pairing, not internet-facing TLS. Use HTTPS for remote API clients: setting both `OPENPLOD_TLS_CERT` and `OPENPLOD_TLS_KEY` (PEM file paths) makes the service listen with TLS; setting only one is a startup error. The server logs a warning when it listens on a non-loopback address without TLS. API responses disable caching.

Every request is resolved to one caller (`src/api/access.ts`):

| Caller | Token | Access |
| --- | --- | --- |
| `api` | `OPENPLOD_API_TOKEN` | Everything, including paired-device management. Use it for MCP, scripts, and remote administration |
| `desktop` | `OPENPLOD_PAIRING_TOKEN`, from a loopback address | Everything. This is the desktop app talking to its own service |
| `client` (legacy) | `OPENPLOD_PAIRING_TOKEN`, from the network | A phone paired before per-device credentials. It appears as the revocable client `legacy`; see [Paired Mobile Clients](#paired-mobile-clients) |
| `client` | A per-device token issued by `POST /api/mobile/clients` | Only the permissions granted to that device (`read`, `write`, `upload`, `sync`) |
| `open` | None, and neither environment token is set | Everything except `/api/mobile/*`, which always requires pairing. Development only |

Tokens are compared in constant time. A missing, unknown, revoked, or expired token is `401 unauthorized`. For a paired device outside `/api/mobile`, `GET`/`HEAD`/`OPTIONS` need `read` and every other method needs `write`; a missing permission is `403 forbidden`. CORS only admits `localhost`, `127.0.0.1`, `::1`, and Tauri origins.

## Contract

Successful responses use `{ "success": true, "data": ... }`. Failures use `{ "success": false, "code": "revision_conflict", "error": "..." }`.

| Status | Meaning |
| --- | --- |
| 200 / 201 | Successful operation / created resource |
| 400 | Invalid JSON, unknown fields, missing confirmation, or invalid input |
| 202 | Accepted long-running work (batch, analysis still running, vault backup/verify/restore, Plaud import); poll the returned id |
| 401 | Missing or invalid API/pairing token |
| 403 | A paired device lacks the permission, local-only mode blocks the action, or the action is reserved for the desktop |
| 404 | Document, folder, active recording, version, or destination unavailable |
| 409 | Stale revision, duplicate request key with different content, cycle, invalid retention state, cloud consent or cost confirmation required |
| 410 | The document's 30-day restore window expired, or a mobile sync cursor is no longer valid |
| 413 | Request body exceeds 4 MB; Markdown itself is limited to 512 KB of UTF-8; an upload chunk or file is too large |
| 422 | An upload chunk or completed file does not match its SHA-256 |
| 503 | Destination configuration, provider, or mobile pairing is invalid or unavailable |

IDs and note/delivery/generation idempotency keys are UUIDs; the job `Idempotency-Key` is 1-128 visible ASCII characters (see [Processing Jobs](#processing-jobs)). Mutable resources have a positive integer `revision`. Read first, then submit that revision with updates, moves, Trash, restore, or purge. A conflict does not overwrite newer data. Titles are 1-180 characters without control characters or path separators.

Folders are logical SQLite-backed collections, not arbitrary filesystem paths. A note is stored independently of its source transcript and audio. Moving or deleting a note never moves or deletes the recording. Unsaved UI drafts use per-tab session storage when available; they are not synchronized or durable server saves.

## Endpoints

All paths below are relative to `/api/v1`.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/` | API capabilities, Markdown size limit, retention period |
| GET | `/folders` | Flat folder tree with `parentId`, `revision`, direct active-document counts |
| POST | `/folders` | `{ name, parentId?: UUID \| null }` |
| PATCH | `/folders/:id` | `{ revision, name?, parentId? }`; rejects cycles and duplicate sibling names |
| DELETE | `/folders/:id` | `{ revision }`; only empty folders, including Trash contents |
| GET | `/documents` | Paginated summaries; filters described below |
| POST | `/documents` | `{ title, content?, folderId?, tags?, properties?, idempotencyKey }` |
| GET | `/documents/:id` | Complete note including content, tags, properties, source references, revision, retention dates |
| PATCH | `/documents/:id` | `{ revision, title?, content?, folderId?, starred?, tags?, properties? }` |
| GET | `/documents/:id/source` | The exact transcript version the note cites, resolved: `current`, `stale`, `unknown`, or `none` |
| POST | `/documents/:id/suggestions` | AI title and tag proposals; nothing is written. See [Document Suggestions](#document-suggestions) |
| GET | `/tags` | Tags on active notes with counts, `[{ tag, count }]` |
| GET | `/views` | Saved document views, by name; see [Saved Views](#saved-views) |
| POST | `/views` | `{ name, filters }`; filters are the `GET /documents` filters without pagination |
| PATCH | `/views/:id` | `{ revision, name?, filters? }` |
| DELETE | `/views/:id` | `{ revision }`; notes are not affected |
| GET | `/exports/markdown` | Managed Markdown export status; see [Managed Markdown Export](#managed-markdown-export) |
| POST | `/exports/markdown` | `{ dryRun: true }` to preview, or `{ confirm: true, overwrite?: [documentId] }` to write |
| GET | `/recordings/:id/transcript-versions` | Saved transcript versions, newest first, without text; `current` flag and citing-note count |
| GET | `/transcript-versions/:id` | One transcript version including `fullText` |
| GET | `/transcript-versions/:id/backlinks` | `{ version, documents }`: active notes citing exactly this version |
| GET | `/jobs` | Processing jobs, newest first; see [Processing Jobs](#processing-jobs) |
| POST | `/jobs` | Create a transcription job: `confirm`, cloud consent, cost confirmation, `Idempotency-Key` |
| GET | `/jobs/:id` | One job descriptor |
| POST | `/jobs/:id/cancel` | Cancel exactly this queued or running job |
| GET | `/document-templates` | Document generation templates (`notes`, `meeting`, `interview`, `lecture`, `brief`, `prd`, `email`) without their prompts |
| PUT | `/exports/markdown/folder` | `{ path, confirm: true }`; choose the managed export folder (see [Managed Markdown Export](#managed-markdown-export)) |
| GET/POST/PATCH/DELETE | `/collections[/:id[/recordings]]` | Recording collections; see [Recording Collections](#recording-collections) |
| GET | `/search` | Hybrid search; `/search/status`, `POST /search/reindex`, `PUT /search/settings`; see [Hybrid Search](#hybrid-search) |
| POST | `/recordings/:id/suggestions` | Recording title/tag proposal; `GET /topics`, `POST /topics/summary`; see [Recording Suggestions](#recording-suggestions-and-recurring-topics) |
| GET/POST/PATCH/DELETE | `/webhooks[/:id]` | Signed webhook subscriptions, deliveries, redelivery, test; see [Webhooks](#webhooks) |
| GET/POST/PATCH/DELETE | `/automations/rules[/:id]` | Opt-in automation rules, preview, run history; see [Automation Rules](#automation-rules) |
| GET/POST/PATCH/DELETE | `/automations/tasks[/:id]` | Reviewed task drafts, connectors, export, calendar; see [Reviewed Tasks and Connectors](#reviewed-tasks-and-connectors) |
| GET | `/transcription-profiles` | Saved profiles and built-in presets; see [Transcription Profiles](#transcription-profiles) |
| POST/PATCH/DELETE | `/transcription-profiles[/:id]` | Create (or copy a preset), edit, delete |
| DELETE | `/documents/:id` | `{ revision }`; move to 30-day Trash |
| POST | `/documents/:id/restore` | `{ revision }`; restore during the retention window |
| POST | `/documents/:id/purge` | `{ revision, confirm: true }`; permanently remove a trashed note and history |
| GET | `/documents/:id/versions` | Version summaries, newest first; `offset` paginates in groups of 30 |
| GET | `/documents/:id/versions/:versionId` | Historical title and Markdown |
| POST | `/documents/:id/versions/:versionId/restore` | `{ revision }`; restore content as a new revision |
| GET | `/documents/:id/export?format=md` | Download exact saved Markdown; `format=json` includes metadata |
| GET | `/transcripts/:recordingId` | Read source metadata and current transcript; optional `versionId` selects history |
| POST | `/documents/from-transcript` | `{ recordingId, versionId?, folderId?, title? }`; independent, provenance-linked snapshot |
| POST | `/documents/generate` | AI generation with the configured text provider; SSE `progress` (`{ id, stage }`), `result`, or `error` events; no note saved yet |
| GET | `/generations/:id` | Private generation result and timestamped processing trace |
| POST | `/generations/:id/save` | `{ folderId? }`; save reviewed AI output once as a new note |
| GET | `/destinations` | Configured destination ID, name, and host only; no secrets or full URL |
| POST | `/documents/:id/send` | `{ destinationId, revision, confirm: true, idempotencyKey }` |
| GET | `/documents/:id/deliveries` | Latest 30 delivery attempts, without provider response bodies |

Routes outside `/api/v1`: AI settings and spending (`/api/ai-settings`, see [AI Settings, Spending, and Cost Confirmation](#ai-settings-spending-and-cost-confirmation)), saved chat (`/api/ai`), onboarding (`/api/onboarding`), mobile clients, uploads, and sync (`/api/mobile`, see [Mobile API](#mobile-api)), vault backup and restore (`/api/vault`, see [Vault Backup and Restore](#vault-backup-and-restore)), recordings (`/api/recordings`, see [Recording Routes](#recording-routes)), Plaud (`/api/plaud`), and the older system routes listed in [System and Legacy Routes](#system-and-legacy-routes).

`GET /documents` accepts:

- `view=all|starred|trash` (default `all`, excluding Trash).
- `folderId=<UUID>` for direct members only, or `folderId=inbox` for unfiled notes.
- `q=<text>` for indexed full-text token-prefix search across titles and Markdown.
- `tag=<tag>` for notes carrying that tag, compared case-insensitively. Composes with every other filter.
- `sort=updated|title`, `offset=0`, and `limit=30` (maximum 100).

Response: `{ documents: [...], total, offset, limit }`. Summaries include a short excerpt and the note's `tags`, not the entire Markdown body. Up to 1,000 folders and 32 nesting levels are supported.

## Tags, Properties, and Sources

Tags are freeform: up to 32 per note, 1-64 characters, no commas or control characters. They are trimmed, deduplicated case-insensitively (the first spelling is kept), and returned sorted. Sending `tags` on `PATCH` replaces the whole set; omitting it keeps the current tags.

`properties` is a schemaless JSON object (up to 64 keys, 16 KB). Values are stored verbatim, so a number stays a number and an object stays an object. `PATCH` merges by key: keys you send replace their values, `null` removes a key, and keys you omit are kept. Changing tags or properties creates a new revision and uses the same `409` conflict rule as any other edit.

A note written from a transcript records the exact transcript version it read (a generated note written from "the current transcript" records the version that was current at the time). `GET /documents/:id/source` resolves it:

| `status` | Meaning |
| --- | --- |
| `current` | The cited version is the recording's current transcript |
| `stale` | The cited version still exists, but the transcript has been edited or another version promoted since; `stale: true` |
| `unknown` | The note names a source that can no longer be found; no substitute text is returned |
| `none` | The note was not written from a transcript |

The response also carries `recordingId`, `recordingFilename`, `recordingAvailable` (false when the recording is in Trash or gone), `versionId`, `versionOrigin`, `versionCreatedAt`, and `currentVersionId`. Notes keep citing their version after a newer one is promoted; they are never rewritten. Backlinks exclude notes in Trash, and a restored note reappears.

## Saved Views

A saved view stores a named set of `GET /documents` filters: `folderId`, `view`, `q`, `sort`, and `tag`. Pagination is never saved, and the notes are listed live each time, so a view always reflects the current vault. Names are 1-80 characters and unique case-insensitively; up to 100 views. Renames and filter changes use the same revision rule as notes (`409` on a stale `revision`). A view that names a folder or tag that no longer exists simply lists nothing.

```json
{ "id": "…", "name": "Client work", "filters": { "view": "all", "q": "", "sort": "updated", "tag": "acme" }, "revision": 1, "createdAt": "…", "updatedAt": "…" }
```

## Managed Markdown Export

A one-way export of every active note into a chosen folder, such as an Obsidian vault. `OPENPLOD_EXPORT_DIR` (an absolute path to an existing folder) always wins and locks the folder (`source: "env"`, `locked: true`). Otherwise the app chooses it with `PUT /exports/markdown/folder` `{ "path": "/abs/folder", "confirm": true }` (`path: null` forgets it): the folder must exist, be absolute, not be a drive root, and lie outside the private vault (database and audio library); the request needs `confirm: true` and, like every `/api` route, the vault token. The desktop app picks the folder with a native dialog (Tauri command `pick_export_folder`); a browser types the path. An API token can therefore also set the folder, only through this endpoint with explicit confirmation; MCP cannot reach it. While `OPENPLOD_EXPORT_DIR` is set the endpoint returns `409 export_root_locked`. Without a folder, `GET /exports/markdown` reports `configured: false` and a run returns `503`. Status: `{ configured, root, source, locked, lastExportedAt, documentCount, attachmentCount, error }`.

Each note becomes `<folder path>/<title>.md`, following the note's folder tree, with names made portable (no path separators, reserved or control characters). The file starts with YAML front matter: `openplod_id`, `title`, `revision`, `updated`, `tags`, and when present `source_recording`, `source_version`, `source_origin`, and `properties`. The body is the saved Markdown, unchanged.

`.openplod-export.json` in the folder records, per note, the path and SHA-256 of what OpenPlod last wrote. Each run compares the file on disk against it:

| `action` | Meaning |
| --- | --- |
| `created` | New note, written to a free path. A file OpenPlod does not own is never replaced; the note gets `Title (2).md` instead |
| `updated` | The file still matched the manifest and was replaced with the new text |
| `moved` | The note was renamed or moved; the new file was written and the old one removed, because it still matched the manifest |
| `unchanged` | Nothing to do. Only counted, not listed |
| `conflict` | The file was edited (`modified_externally`), deleted (`deleted_externally`), or replaced by a folder or symlink (`not_a_file`) outside OpenPlod. It is left alone |
| `orphaned` | The note is in Trash or purged. Its file and manifest entry are kept, never deleted |

A conflict is only resolved by naming that note in `overwrite` on a confirmed run, which replaces or recreates its file; symlinks are never followed or replaced. Run `{ "dryRun": true }` first: it reports exactly the same actions without writing anything. A real run requires `confirm: true`. Writes go through a temporary file and an atomic rename, and only one export runs at a time (`409 export_running`). An invalid manifest stops the run with `409 manifest_invalid` before anything is written; move it aside to start over. If a run fails midway, the manifest still records the files it wrote, so the next run does not treat them as foreign.

Response: `{ root, dryRun, exportedAt, counts: { created, updated, moved, unchanged, conflict, orphaned }, items: [{ documentId, title, path, action, reason?, kind?, attachmentKey? }] }`.

**Attachments.** `attachments: { "audio": true, "transcript": true }` copies, for every note written from a recording, the recording's stored audio and the exact cited transcript version (with small front matter naming the recording and version) into `attachments/`. The note's front matter lists them under `attachments`. Each attachment is written once per run however many notes cite it, recorded in the manifest under `attachments` (keyed `audio:<recordingId>` or `transcript:<versionId>`) with its path and SHA-256, and follows the same rules as notes: never written over an external change unless named in `overwriteAttachments`, never replacing a file OpenPlod did not write (a suffix is used), kept when no note cites it any more (`orphaned`). Recordings in Trash and missing audio files are skipped. Audio is compared by its vault fingerprint (SHA-256) and the file on disk is re-hashed on each run.

## Document Suggestions

`POST /documents/:id/suggestions` asks the configured **summaries** provider (`analysisProvider`) for a
title and up to five tags (roadmap KB-05). Nothing is written: the response is a proposal, and
applying it is an ordinary `PATCH /documents/:id` with the current `revision`.

```json
{ "documentId": "…", "revision": 3, "title": "OpenPlod 1.0 release plan", "tags": ["planning", "shipping"], "provider": "mistral", "model": "mistral-small-latest", "truncated": false }
```

`title` is `null` when the model offered nothing usable or repeated the current title. `tags` only
contains lower-cased tags the note does not already carry. Only the first 24,000 characters of a
long note are sent, and `truncated` says so. The note text is sent as untrusted data with an
instruction to ignore any instructions inside it. Errors: `409 document_in_trash`, `400
empty_document`, `503 provider_unavailable` (no key, or local-only mode blocks the provider), and
`503 provider_failed` / `invalid_suggestion`. Configured `analysisFallback` providers are tried in order after the primary fails; there is no other automatic retry.

## Transcription Profiles

`/api/v1/transcription-profiles` stores named transcription hints. A profile is sent with the audio;
it never changes transcript text.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/transcription-profiles` | `{ profiles, presets }`. Presets are built in and read-only |
| POST | `/transcription-profiles` | A profile body, or `{ preset, name? }` to copy a preset. `201`; `409` when the name is taken (case-insensitive) |
| GET | `/transcription-profiles/:id` | One profile; `404` when unknown |
| PATCH | `/transcription-profiles/:id` | Any profile fields. Changing `engine` without a `model` clears the model |
| DELETE | `/transcription-profiles/:id` | Removes it. If it was the default, `transcriptionProfile` is cleared |

```json
{ "id": "…", "name": "Medical consultation", "description": "…", "engine": null, "model": null, "language": null, "diarize": true,
  "prompt": "A medical consultation between a clinician and a patient. …", "vocabulary": ["amoxicillin"], "createdAt": "…", "updatedAt": "…" }
```

`engine`, `model`, `language`, and `diarize` are `null` to inherit the AI settings. `prompt` is up to
1,000 characters; `vocabulary` up to 100 terms of 80 characters. A profile with an `engine` is
checked against that provider when saved: a model it does not offer, speaker labels it cannot
produce, or a prompt or vocabulary it cannot take is a `400`.

**How a job resolves its settings.** AI settings carry two related fields: `transcriptionPrompt`
(a one-off context, up to 2,000 characters) and `transcriptionProfile` (the default profile id, or
`""`). `POST /api/recordings/:id/reprocess` accepts both as overrides. When the job runs:

1. A profile with an `engine` selects that provider and its `model`; otherwise the settings' provider is used.
2. The profile's `language` and `diarize` replace the settings' values when set.
3. Vocabularies are merged (settings first, duplicates removed). The prompt is the job's prompt, then the profile's.
4. A profile **without** an `engine` leaves out the hints the provider cannot take (`prompt`,
   `vocabulary`, `speaker labels`) instead of failing. A prompt or vocabulary set directly on the
   job or in settings for a provider that cannot take it is still refused with `400`.

The transcript version's `provenance.options` records what was sent, including `prompt`,
`profile: { id, name }`, and `ignoredProfileHints` when anything was left out. A job whose profile
has been deleted fails with a message naming the problem; it does not fall back silently.

## Onboarding

First-run state lives under `/api/onboarding`, outside `/api/v1`. It never changes AI settings; the
setup guide saves those through `PUT /api/ai-settings`.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/onboarding` | `{ completedAt, skipped, privacyMode, engine, engineLabel, engineReady, recordings, documents, profiles, defaultProfile }`. `engineReady` means a key or local binary is present; no provider is contacted |
| POST | `/onboarding/complete` | `{ skipped?: boolean }` |
| POST | `/onboarding/reset` | Shows the guide again on next load |

## AI Chat Conversations

Saved chat conversations live under `/api/ai`, outside the versioned `/api/v1` contract:

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/conversations?archived=false` | Up to 30 conversations, newest activity first: `{ id, title, question, recordingIds, createdAt, turns, archived }`. `archived=true` lists the archive instead |
| GET | `/conversations/:id` | Every saved answer, with sources and citations |
| PATCH | `/conversations/:id` | `{ title?: string \| null, archived?: boolean, pinnedRecordingIds?: string[], contextNote?: string \| null }`; metadata only, saved answers are never changed. `title: null` returns to the first question. Pins and the note can be set before the first question |
| GET | `/conversations/:id/context` | `{ id, pinnedRecordingIds, contextNote }` |
| GET | `/conversations/:id/export?format=md` | The complete conversation as Markdown, each cited quote resolved to its recording, timestamp, and transcript version; `format=json` returns every saved answer |

`question` is the latest question asked. Asking a follow-up question in an archived conversation returns it to the main list.

`POST /api/ai/ask` accepts an empty `recordingIds`: up to 16 passages are then retrieved across the vault with hybrid search (Trash excluded) and only those are sent. Pinned recordings are always included in full, and the project note is sent as `projectContext`, marked as untrusted background that can never be cited. Answers carry `retrieval: { mode, pinnedRecordingIds, sentRecordingIds, usedRecordingIds, contextNote, embeddingModel }`, sources carry `via`, `end`, `segmentStart`/`segmentEnd`, and `matchedBy`, and `followUps` holds up to three suggested questions that the app shows but never sends by itself. Conversations whose sources are in Trash are not listed or exported.

## Recording Collections

Named, revision-checked sets of recordings (KB-01). Names are 1-80 characters and unique case-insensitively; up to 500 collections. `recordingCount` counts active recordings only: a recording in Trash stays a member and reappears when restored; purging it removes it from every collection.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/collections` | `[{ id, name, description, revision, createdAt, updatedAt, recordingCount }]` |
| POST | `/collections` | `{ name, description? }`, `201`; a duplicate name is `409 collection_exists` |
| GET | `/collections/:id` | The collection plus `recordingIds` (active, newest first) |
| PATCH | `/collections/:id` | `{ name?, description?, revision }` |
| DELETE | `/collections/:id` | `{ revision }`; recordings are untouched |
| POST | `/collections/:id/recordings` | `{ recordingIds, revision }`; only active recordings |
| DELETE | `/collections/:id/recordings` | `{ recordingIds, revision }` |

Every change bumps `revision`; a stale one is `409 revision_conflict`. `GET /api/recordings?collection=<id>` lists one collection, and list rows carry `collectionIds`.

## Hybrid Search

`GET /search?q=&mode=hybrid&source=all&limit=20` (KB-04) searches the **current transcript version of active recordings** and **active notes**, cut into passages. Transcript passages are runs of whole segments carrying the inclusive `segmentStart`/`segmentEnd` index range and `startTime`/`endTime` taken from those segments; text without complete segments gets `null` times, never estimates. Each result names the exact `versionId`.

```json
{ "id": "…", "sourceType": "transcript", "recordingId": "…", "recordingTitle": "Budget review.m4a", "versionId": "…", "documentId": null, "documentTitle": null,
  "segmentStart": 0, "segmentEnd": 1, "startTime": 0, "endTime": 40, "text": "…", "score": 0.73, "scores": { "fts": 1, "vector": 0.45 }, "matchedBy": ["fts", "vector"] }
```

`mode` is `hybrid`, `lexical` (FTS5 bm25 only), or `semantic` (vectors only). Up to 50 candidates come from each retriever; the hybrid score is `0.5 × bm25/best bm25 + 0.5 × max(0, cosine)`. The response also has `embedding: { model, kind: "lexical" | "local" | "cloud", fallback, note }` and `index: { sources, passages, pending }`. A search first indexes up to 25 new or changed sources.

Embeddings are local by default: `auto` uses an installed Ollama embedding model (`nomic-embed-text` unless changed), otherwise a built-in, offline **lexical** fallback (signed hashed bag-of-words, SMART `lnc.ltc` TF-IDF; its vector matches are limited to passages sharing a word, so it is not semantic). OpenAI (`text-embedding-3-small`) or Mistral (`mistral-embed`) embeddings are used only when selected with `PUT /search/settings { "embeddingProvider": "openai", "cloudOptIn": true, "confirmCloud": true }`, a key is configured, and local-only mode is off; otherwise the lexical index is used and `note` says why. `GET /search/status` reports settings and counts; `POST /search/reindex { maxSources?, rebuild? }` indexes now. Searches cache the list of installed Ollama models for 30 seconds (15 seconds when Ollama is unreachable), so a newly installed model can take that long to be used; `GET /api/ai-settings/ollama-models` always asks Ollama directly.

Vectors are stored in SQLite as float32 BLOBs per passage and model, with a SHA-256 of the exact source text. Database triggers delete cached passages and vectors when a recording goes to Trash or is purged, when a new transcript version becomes current, and when a note is edited, trashed, or purged; every query also re-checks that each passage still belongs to the current version of an active source.

## Recording Suggestions and Recurring Topics

`POST /recordings/:id/suggestions { "consent": true }` returns `{ recordingId, revision, versionId, title, tags, provider, model, truncated }` from the analysis provider. Nothing changes; applying is an ordinary `PATCH /api/recordings/:id` with the revision. `GET /topics?days=30` counts recording tags and transcript words shared by at least two recent recordings, locally. `POST /topics/summary { topic, days, consent: true }` retrieves matching passages from those recordings and returns a cited Markdown **preview** `{ topic, markdown, summary, sources, citations, provider, model }`; every quote must be an exact substring of a supplied passage. Saving it is an ordinary `POST /documents`.

## Processing Jobs

`/api/v1/jobs` is a stable view over the durable processing queue. `POST /jobs` creates a transcription (below); other jobs are created by import, reprocess, analyze, and batch flows, which keep their per-recording idempotency (a retried submission for a recording with a queued or running job returns that job rather than creating a second one or a second paid call). Fields may be added within `/api/v1`; existing fields keep their meaning.

```json
{
  "id": "5f0c…",
  "type": "process-recording",
  "state": "complete",
  "createdAt": "2026-10-12T09:00:00.000Z",
  "startedAt": "2026-10-12T09:00:01.000Z",
  "completedAt": "2026-10-12T09:02:10.000Z",
  "error": null,
  "recordingId": "8a1e…",
  "provider": "mistral",
  "priority": 0,
  "checkpoint": { "phase": "polling", "remoteId": "provider-job-id" },
  "progress": { "done": 3, "total": 5 },
  "attempts": 0,
  "resultRefs": { "transcriptVersionIds": ["5f0c…"] }
}
```

`progress` is set for chunked long-audio transcriptions (chunks finished of total) and `null` otherwise. `attempts` counts automatic retries; at most two are made (after 5 s and 30 s), and only for errors marked retryable, such as an ffmpeg split failure, when the checkpoint shows nothing outstanding at a provider. A cloud request that may have been sent is never retried automatically. `resultRefs.transcriptVersionIds` lists a version only once it exists.

`state` is `pending`, `running`, `complete`, `failed`, or `cancelled`. `GET /jobs` accepts `state`, `type`, `recordingId`, `offset`, and `limit` (maximum 100) and returns `{ jobs, total, offset, limit, stats }`. Unknown ids return `404` with `code: "job_not_found"`; cancelling a finished job returns `409` with `code: "job_not_cancellable"`. Cancelling affects only the named job, never other work on the same recording.

After a restart, a job interrupted before the provider confirmed receipt is marked `failed` (and its recording shows the failure) rather than resubmitted, because the provider may already have billed it. A job with a known remote id resumes polling. Finished jobs are kept for 30 days (at most 1,000) and pruned at startup.

**Creating a transcription.** `POST /jobs`:

```json
{ "type": "process-recording", "recordingId": "8a1e…", "options": { "transcriptionEngine": "openai", "transcriptionModel": "whisper-1" },
  "confirm": true, "acceptCloudProvider": true, "confirmCost": true }
```

| Field | Meaning |
| --- | --- |
| `type` | Only `process-recording` |
| `options` | Overrides for `transcription*` settings only (engine, model, language, diarize, vocabulary, prompt, profile, fallback, chunking); anything else is `400 invalid_options` |
| `dryRun` | Return `{ plan, job: null }` without queueing. `plan` is `{ recordingId, provider, model, profile, local, requiresCloudConsent }` |
| `confirm` | Must be `true`, otherwise `400 confirmation_required` (with `data.plan`) |
| `acceptCloudProvider` | Must be `true` when `plan.requiresCloudConsent` (audio leaves this computer), otherwise `409 cloud_consent_required` |
| `confirmCost` | Required when the cost gate asks for it, otherwise `409 cost_confirmation_required`; see [Cost confirmation](#cost-confirmation) |
| `idempotencyKey` | Same as the `Idempotency-Key` header; the header wins when both are sent |

Success is `201 { plan, replayed: false, job }`. **Idempotency:** an `Idempotency-Key` (1-128 visible ASCII characters) makes a retry with the same request (type, recording, options) return the same job (`200`, `replayed: true`) whatever its state, without a second provider call; the same key with a different request is `409 idempotency_conflict`, and a key whose job has been pruned is `409 idempotency_expired`. Keys are stored in `job_requests` and checked before anything else. Other errors: `404 recording_not_found` (missing or in Trash), `400 invalid_options` (unknown profile, an option the provider does not support, or local-only mode blocks the provider), and `409 job_active` while another transcription of the recording is queued or running.

`POST /api/recordings/:id/reprocess` uses the same submission path: its JSON body holds the `transcription*` overrides plus an optional `confirmCost`, it accepts the `Idempotency-Key` header, and it returns `{ message, data: { jobId, state, replayed } }` or the same error codes. It does not require `confirm` or `acceptCloudProvider`; the desktop dialog discloses the provider instead.

**Analysis jobs.** `POST /api/recordings/:id/analyze` runs through the queue as an `analyze-recording` job (priority 5, `provider` = analysis provider), so it is listed and cancellable here. The request waits up to two minutes and then answers `202 { jobId, state }`. Auto-summary after transcription still runs inside the `process-recording` job.

**Cancelling.** Cancel stops local work. The job error then says that a submitted provider request may still be billed. For an AssemblyAI job with a known remote id, OpenPlod also asks AssemblyAI to delete that transcript (best effort) and appends the outcome sentence to the job error. Acceptance of that request is not proof that billing stopped. No request is made in local-only mode or without a key; the error says so.

The older `GET /api/jobs`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/resume`, and `PATCH /api/jobs/:id` keep their shape. Job objects there carry `recordingId`, `provider`, an optional `startedAt`, and a trimmed `checkpoint { phase, remoteId, inFlight, progress }` (no chunk payloads). `resume` only restarts a failed or cancelled job whose checkpoint has a remote id or shows nothing in flight.

## Create and Update a Note

Example request body for `POST /api/v1/documents`:

```json
{
  "title": "Weekly review",
  "content": "# Weekly review\n\n- [ ] Review the onboarding flow\n",
  "folderId": null,
  "idempotencyKey": "12345678-1234-4234-8234-123456789abc"
}
```

Use a fresh UUID for each logical create, and reuse it only for retries of the exact same request. A duplicate key with different content returns `409`. Subsequent edits use `PATCH /documents/:id`, for example `{ "revision": 1, "content": "# Updated note\n" }`.

Snapshot imports deduplicate by recording plus transcript version (or content fingerprint for a legacy unversioned transcript). Saving the same snapshot returns its existing note, including if it is in Trash or was moved/edited. It does not silently restore, move, or replace that note. A new source transcript version can be saved separately.

### AI Documents

The UI's **Create document** action (`POST /documents/generate`) generates structured Markdown with the configured **documents** provider (`documentProvider`/`documentModel` in AI settings, then its explicit `documentFallback` entries in order; see [ai-providers.md](ai-providers.md#per-task-fallback)). It does not call the snapshot endpoint. A request contains `{ idempotencyKey, recordingId, versionId?, title, style?, instructions?, expectedProvider? }`, where `style` is one of the templates from `GET /document-templates` (`notes`, `meeting`, `interview`, `lecture`, `brief`, `prd`, `email`) and `instructions` is up to 2,000 characters. `expectedProvider` is the provider the person was shown; if the configured primary provider differs, the request fails with `409 provider_changed` before anything is sent. The server retrieves the selected saved transcript and sends its text, title, and optional writing instructions to that provider. Original audio is not sent by this operation.

Generation streams workflow stages as SSE `progress` events (plus `keepalive` every 10 seconds) and ends with `result` or `error`; the result is a reviewable draft. Only `/generations/:id/save` creates a note. Provider errors, cancellation, invalid output, and the 90-second timeout never fall back to a copied transcript. Inputs above 100 KB are rejected without truncation (`413 transcript_too_large`). At most two generations run concurrently per desktop service (`409 generation_busy`). Reusing a completed request ID returns its existing result; the same ID with different input is `409 generation_conflict`, and a pending or failed ID is `409 generation_incomplete` and is not retried automatically. Failed/restarted requests require an explicit new generation. `GET /generations/:id` includes `provenance { provider, model, usage, startedAt, completedAt, fallbackFrom }`, where `fallbackFrom` lists any providers that failed before the one that answered.

The saved document preserves source recording/version references, a generated initial version, provider/model provenance, and a private generation trace. Subsequent user edits use normal note revisions. Uncommitted generation drafts older than 24 hours are cleaned up when another generation starts; saved traces are removed when their document is permanently purged. These AI outputs can contain mistakes and should be reviewed before saving or sending.

Note history includes saved content and metadata changes. Restoring history copies its title and Markdown into a new revision; it does not rewind the current folder, star state, or source provenance. Expired note and recording Trash is purged when the backend starts and every six hours while it runs. This is retention cleanup, not forensic secure erasure.

## Send to a Destination

The server only sends to named destinations configured by its owner. There is no API for supplying an arbitrary URL, headers, or credentials with a send request. Configuration requires a private JSON file owned by the server user, mode `0600` on macOS/Linux:

```text
~/Library/Application Support/com.openplod.vault/openplod-destinations.json
```

A source-run backend defaults to the parent of `OPENPLOD_LIBRARY_PATH`, usually `./data/openplod-destinations.json`. Override it with `OPENPLOD_DESTINATIONS_FILE`. Example configuration (replace placeholders locally, never commit real URLs containing secrets):

```json
[
  {
    "id": "workflow",
    "name": "My automation",
    "url": "https://automation.example.com/hooks/openplod",
    "bearerToken": "replace-with-your-private-receiver-token"
  }
]
```

Destinations must use HTTPS without URL user credentials or fragments. Configuration is local administrative authority: choose hosts you trust with the document. Requests use a 10-second timeout, reject redirects, and send:

```json
{
  "schemaVersion": "1",
  "event": "document.export",
  "deliveryId": "12345678-1234-4234-8234-123456789abc",
  "document": {
    "id": "12345678-1234-4234-8234-123456789abd",
    "title": "Weekly review",
    "content": "# Weekly review\n",
    "revision": 2,
    "sourceRecordingId": null,
    "sourceVersionId": null
  }
}
```

Headers are `Content-Type: application/json`, `Idempotency-Key: <deliveryId>`, and optional bearer authorization. This generic contract can be received by an n8n workflow or your own service; Slack, Notion, and other SaaS APIs require a receiver that maps the payload to their specific API. No SaaS account is automatically connected.

Delivery state is `pending`, `sent` (HTTP 2xx accepted), or `unknown`. A timeout, rejected redirect, network failure, or non-2xx response is not proof that the receiver performed no work. The attempt is persisted before sending; reusing its idempotency key retrieves the same attempt without another POST. There are no automatic retries. Check the destination before explicitly starting a new delivery with a new key. A stale pending attempt becomes unknown when delivery history is read after 60 seconds.

## Existing Audio APIs

### Subtitle export

`GET /api/recordings/:id/transcript/subtitles`

Without `format`, returns whether the saved transcript can become subtitles:

```json
{ "success": true, "data": { "exportable": false, "reason": "no-timing",
  "detail": "The transcription provider returned no timings for this recording. Subtitles need real start and end times.",
  "cueCount": 0, "formats": [] } }
```

`reason` is one of `no-segments`, `no-timing`, `invalid-timing`, `empty-text`, or `null` when exportable.

| Query | Meaning |
| --- | --- |
| `format=srt\|vtt` | Download the subtitle file instead of the readiness report |
| `versionId=<id>` | Export a stored transcript version rather than the current one |
| `speakerLabels=1` | Prefix each cue with `Speaker N:` for diarized speakers, or the speaker's name once renamed |

Returns `409` with the refusal reason when a format is requested for a transcript without usable
timings; timings are never invented or interpolated. `400` for an unsupported format, `404` when no
saved transcript exists.

### Transcript PDF

`GET /api/recordings/:id/transcript/pdf[?versionId=<id>]` returns `application/pdf`, rendered on the
server from the stored version (the current one when `versionId` is omitted). Timestamps appear only
when the version has real provider timings; unknown metadata is printed as `unknown`. The built-in
PDF fonts cover English and Western European text; any character they cannot show is drawn as `?`
and the PDF states how many were replaced. The file is 7-bit ASCII. `404` for an unknown version or
a recording without a transcript.

### Saved structure

`POST /api/recordings/:id/transcript/structure` (body `{ versionId? }`) extracts chapters, decisions,
action items and open questions and returns them with a `proposalId`. Nothing is saved. Timestamps
are resolved from the stored segments, never from the model; unstated owners and due dates are
`null`. With `?format=` it returns the extraction as a download instead (unchanged behaviour).

| Route | Meaning |
| --- | --- |
| `POST …/transcript/structures` `{ proposalId }` | Save a reviewed extraction. Each save is a new row; earlier rows are kept. `404` once the proposal expired (1 hour) or was already saved |
| `GET …/transcript/structures` | Saved rows, newest first: `{ id, versionId, structure, provider, model, createdAt, current }`. `current` is false once the transcript moved to another version |
| `GET …/transcript/structures/:structureId[?format=]` | One row, or a download in `markdown`, `chapters`, `csv`, `json`, `html` or `pdf`. No provider is called |
| `DELETE …/transcript/structures/:structureId` | Delete one saved row |

### Batch transcription

`POST /api/recordings/batch/estimate` with `{ recordingIds }` (up to 500) returns `{ recordings,
wouldRun, usesCloudProvider, provider, estimatedCost }`. Recordings that already have a transcript are
not counted in `wouldRun`. `estimatedCost` is the same object as `POST /api/ai-settings/estimate`
returns for the runnable recordings (or `null` when none would run); see
[Cost confirmation](#cost-confirmation).

`POST /api/recordings/batch` with `{ recordingIds, confirm: true, confirmCost? }` starts it (`202`).
`confirm: true` is always required (`400` otherwise). When the estimate needs confirmation, the
request is `409 cost_confirmation_required` with the estimate in `data` until it is repeated with
`confirmCost: true`. Recordings that already have a transcript are skipped; re-transcribing stays a
per-recording action. `{ confirm: true, retryOf }` re-runs the failed items of an earlier batch.

### Batch document generation

`POST /api/recordings/batch/estimate` with `{ kind: "document", recordingIds }` returns
`{ recordings, wouldRun, skipped, provider, model, usesCloudProvider, sendsTranscriptText: true,
providerError, estimatedCost: null }`. Recordings without transcript text are skipped.

`POST /api/recordings/batch` with `{ kind: "document", recordingIds, confirm: true, expectedProvider,
style?, instructions?, folderId? }` starts the batch. Each item runs the normal document pipeline and
saves a new note (with its source transcript version) in the chosen folder. `expectedProvider` must
match the configured document provider (`409 provider_changed` otherwise). `{ kind: "document",
confirm: true, retryOf }` re-runs only the failed items with the original batch's options.
`GET /batch/:batchId` and `POST /batch/:batchId/cancel` work for both kinds.

### Provider comparison

`POST /api/recordings/:id/transcript/provider-comparisons` with `{ provider, model?, confirm: true }`
queues an explicit second transcription of the saved audio with that provider only (no fallback).
The result is an independent `generated` version whose provenance has `comparison: true`; it never
becomes current automatically and never changes the recording's status or revision. A second request
for the same provider while one is queued returns it with `alreadyQueued: true`. `400` without
`confirm`, for an unconfigured or privacy-blocked provider; `409` when the recording has no
transcript yet. `GET` on the same path returns `{ runs, available }`.

## AI Settings, Spending, and Cost Confirmation

AI configuration lives under `/api/ai-settings`, outside `/api/v1`. User-facing behavior (providers, chunking, fallbacks, limits) is in [ai-providers.md](ai-providers.md).

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/api/ai-settings` | The configuration below, plus `credentials` (`{ mistralApiKey: true, … }`, presence only), `capabilities` (speech registry), `textCapabilities`, and `pricing` |
| PUT | `/api/ai-settings` | Save the whole configuration atomically, with optional `credentials`. Every primary and fallback provider is checked against local-only mode first (`400` if blocked) |
| POST | `/api/ai-settings/check/:provider` | Metadata-only connection check with the saved key: `mistral`, `openai`, `anthropic`, `gemini`, `custom`, `ollama`, `deepgram`, `assemblyai`. Sends no audio or transcript. `{ reachable, status }`; `400` without a key or custom URL, `503` when unreachable or blocked by local-only mode |
| GET | `/api/ai-settings/ollama-models` | Installed local Ollama models; remote/cloud entries are excluded. `503` when Ollama is not running |
| GET | `/api/ai-settings/ollama-context?model=` | `{ model, contextLength }` from Ollama's `/api/show`; `contextLength` is `null` when Ollama does not report one. `404` for a model that is not installed |
| GET | `/api/ai-settings/spending` | Month-to-date estimated cloud spend (below) |
| POST | `/api/ai-settings/estimate` | `{ recordingIds (1-500), overrides? }`: transcription cost estimate (below). `overrides` may only contain `transcription*` keys |

### Settings fields

| Field | Values |
| --- | --- |
| `privacyMode` | `selected-providers` or `local-only` |
| `transcriptionEngine`, `transcriptionModel` | `whisper`, `mistral`, `deepgram`, `openai`, `assemblyai`; model from the capability registry or `""` for the default |
| `transcriptionLanguage` | `auto` or an ISO code such as `fr` or `pt-BR`. Rejected only when the model has a documented language list that excludes it |
| `transcriptionDiarize`, `transcriptionVocabulary`, `transcriptionPrompt`, `transcriptionProfile` | Speaker labels; up to 100 terms; up to 2,000 characters; default profile id or `""` |
| `transcriptionFallback` | Up to 4 speech providers, tried in order. Empty by default |
| `transcriptionChunkAboveMinutes` | `0` (split only when a provider's size limit requires it) to `1440` |
| `analysisProvider`/`analysisModel`, `documentProvider`/`documentModel`, `chatProvider`/`chatModel` | `mistral`, `openai`, `anthropic`, `ollama`, `gemini`, `custom`; model `""` uses the provider default (Ollama and custom need a model) |
| `analysisFallback`, `documentFallback`, `chatFallback` | Up to 3 `{ provider, model }` entries each, tried in order after the primary fails. Empty by default |
| `customBaseUrl` | Base URL of a restricted OpenAI-compatible endpoint, or `""`. HTTPS, or plain HTTP only on loopback (`localhost`, `127.0.0.0/8`, `[::1]`); no credentials, query string, or fragment. Anything else is `400` |
| `monthlyBudgetUsd`, `confirmAboveUsd` | `null` (off) or a USD amount. Confirmation thresholds checked against OpenPlod's estimates; no provider enforces them |
| `credentials` | Write-only: `mistralApiKey`, `deepgramApiKey`, `openaiApiKey`, `assemblyaiApiKey`, `anthropicApiKey`, `geminiApiKey`, `customApiKey`. An omitted key is kept; an empty string clears the saved value (an environment variable then applies again, except for `customApiKey`, which never reads the environment) |

The schema is strict: unknown fields are `400`. `textCapabilities` reports, per text provider, `{ defaultModel, local, requiresKey }`; a custom endpoint is `local` only when its URL is loopback. `capabilities` reports, per speech provider, its models, `maxBytes` (OpenAI 25,000,000; AssemblyAI 100,000,000; others `null`), per-model `languages` (a documented ISO 639-1 list, or `null` when OpenPlod holds no reliable list) and per-model `timestampGranularity` (`word`, `segment`, or `none`).

Key storage: Mistral, Deepgram, OpenAI, AssemblyAI, and Anthropic keys are encrypted at rest with the vault key and removed from unencrypted backups. In this build `geminiApiKey` and `customApiKey` are stored in the settings table **without** that encryption and are therefore also present in unencrypted backups. Protect the data directory accordingly.

### Spending

`GET /api/ai-settings/spending`:

```json
{ "month": "2026-10", "currency": "USD", "estimatedUsd": 0.42, "unknownEntries": 1, "entries": 9,
  "budgetUsd": 10, "remainingUsd": 9.58, "confirmAboveUsd": 0.5,
  "label": "Estimate from documented list prices; not a bill, and not enforced by the provider.", "pricesAsOf": "2025-08-01" }
```

Months are UTC calendar months. The ledger (`ai_spend_ledger`) gets one row per cloud transcription job, written as `estimated` before audio is sent and settled as `complete`, `failed`, `cancelled`, or `not-sent` (nothing left this computer; excluded from totals), and one row per finished cloud text request, estimated from the token usage the provider reported. Local providers (Whisper.cpp, Ollama, a loopback custom endpoint) are never recorded. An entry whose price or usage is unknown is counted in `unknownEntries`, never guessed. The price table and its date are in [ai-providers.md](ai-providers.md#spending-limits-and-prices).

### Cost estimates

`POST /api/ai-settings/estimate { "recordingIds": ["…"], "overrides": { "transcriptionEngine": "openai" } }`:

```json
{ "items": [{ "recordingId": "…", "usd": 0.036, "currency": "USD", "durationSeconds": 360, "billedSeconds": 360,
    "provider": "openai", "model": null, "local": false, "unknownReason": null, "label": "…", "pricesAsOf": "2025-08-01" }],
  "totalUsd": 0.036, "unknownCount": 0, "local": false, "currency": "USD", "label": "…", "pricesAsOf": "2025-08-01",
  "confirmationRequired": false, "reasons": [], "monthToDate": { "…": "as GET /spending" } }
```

The transcription profile is applied first. With fallbacks configured, an item uses the most expensive cloud provider in the chain, and any unknown price makes it unknown. When audio would be chunked, `billedSeconds` includes the overlap. `usd` is `null` with an `unknownReason` when the duration is unknown or the provider/model has no documented price (Deepgram, AssemblyAI, unlisted models); `totalUsd` is then `null`.

### Cost confirmation

A cloud job needs explicit cost confirmation when, by OpenPlod's estimate:

- it exceeds `confirmAboveUsd` (or, in a batch, any single recording does), or
- it would take month-to-date spend over `monthlyBudgetUsd`, or
- a threshold or budget is set and the estimate is unknown, so it cannot be checked.

With neither setting configured, nothing extra is asked. Local work never needs it.

| Route | Without `confirmCost: true` |
| --- | --- |
| `POST /api/v1/jobs` | `409 cost_confirmation_required`, `data` = the estimate above |
| `POST /api/recordings/:id/reprocess` | `409 cost_confirmation_required`, `data` = the estimate |
| `POST /api/recordings/batch` (transcription) | `409 cost_confirmation_required`, `data` = the estimate for the runnable recordings |

The gate is checked again when the job runs, including automatic transcription after an import and transcriptions queued by automation rules. A job that needs confirmation but was not confirmed fails with "Cost confirmation required: … Nothing was sent." before any audio leaves the computer; start it again with `confirmCost: true`. A resumed job (known remote id or finished chunks) is not re-gated. The MCP `start_transcription` tool does not send `confirmCost`, so such a job must be started from the app or the API.

### Text provenance and fallback

Summaries (`POST /api/recordings/:id/analyze`), AI documents (`GET /api/v1/generations/:id`), and chat answers (`/api/ai`) carry:

```json
{ "provider": "anthropic", "model": "claude-sonnet-4-5", "usage": { "input_tokens": 5120, "output_tokens": 640 },
  "startedAt": "…", "completedAt": "…", "fallbackFrom": [{ "provider": "mistral", "model": "mistral-small-latest", "error": "mistral request failed (HTTP 503). Check AI settings." }] }
```

`fallbackFrom` is empty when the first choice answered. Summaries and documents nest this object as `provenance`; chat answers carry the same fields directly. Summaries saved before provenance existed have `provenance: null`. `usage` is whatever the provider reported, or `null`. A configured fallback that is unusable (no key, or blocked by local-only mode) is skipped, never used. A cancelled request never falls back, and a request refused because it exceeds a local Ollama model's context never falls back to a cloud provider. The `expectedProvider` check on document and chat requests covers the primary provider only; configuring a fallback in settings is the consent for it.

Transcript versions keep `provenance { provider, model, fingerprint, options, startedAt, completedAt, usage, language }` and, when the audio was split, `chunking { chunks, chunkSeconds, overlapSeconds, rule: "drop-overlap-before-previous-end" }`.

## Webhooks

`/api/v1/webhooks` sends signed JSON events to URLs you register. Delivery is at-least-once with stable ids for deduplication. See [automation.md](automation.md#webhooks) for the user guide.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/webhooks` | `{ subscriptions, eventTypes }` |
| POST | `/webhooks` | `{ name, url, eventTypes, includeText?, enabled?, acknowledgeExternal?, acknowledgeText? }`, `201`. The response includes `secret`, shown only here and on rotation |
| GET | `/webhooks/:id` | One subscription |
| PATCH | `/webhooks/:id` | Any of the create fields. Setting `enabled: true` on a disabled subscription clears `disabledReason` and the failure counter |
| DELETE | `/webhooks/:id` | Removes the subscription and its delivery history |
| POST | `/webhooks/:id/rotate-secret` | New secret, returned once; the old one stops signing immediately |
| POST | `/webhooks/:id/test` | Sends a signed `webhook.test` event now and returns the delivery (also for a disabled subscription) |
| GET | `/webhooks/:id/deliveries?limit=50` | Latest deliveries (1-200), newest first, each with its `attempts`. Finished deliveries older than 90 days are pruned (see below) |
| GET | `/webhooks/deliveries/:deliveryId` | One delivery with attempts |
| POST | `/webhooks/deliveries/:deliveryId/redeliver` | Sends the same delivery again now, reusing its event and delivery ids |

**History retention.** Every six hours the server removes finished deliveries (any status except `pending` and `delivering`) last updated more than 90 days ago, with their attempts. The event row stays as the deduplication record with its payload cleared, so a re-emitted event is still not delivered twice. A pruned delivery returns `404` and cannot be redelivered.

```json
{ "id": "…", "name": "n8n", "url": "https://n8n.example.com/webhook/openplod", "host": "n8n.example.com", "external": true,
  "eventTypes": ["recording.transcribed", "document.created"], "includeText": false, "enabled": true,
  "disabledReason": null, "consecutiveFailures": 0, "createdAt": "…", "updatedAt": "…" }
```

**Rules for subscriptions.** Names are 1-80 characters. The URL must be HTTPS, or plain HTTP to `localhost`, `127.0.0.1`, or `[::1]`, with no credentials or `#fragment` (up to 2,048 characters). A URL that leaves this computer needs `acknowledgeExternal: true` on create, and again when it is changed to a different external URL (`400 external_ack_required`). `includeText: true` needs `acknowledgeText: true` when it is turned on (`400 text_ack_required`). The full URL is returned by the API; keep tokens out of it.

**Events.**

| `type` | `data` |
| --- | --- |
| `recording.imported` | `{ recordingId, recordingType, durationSeconds, recordedAt, sourceProvider, sourceTransport, filename }` |
| `recording.transcribed` | `{ recordingId, transcriptVersionId, provider, model, current }`, plus `text` (or `textUnavailable: true` when the recording is in Trash) with `includeText` |
| `document.created` | `{ documentId, title, folderId, revision, sourceRecordingId, sourceVersionId, createdAt }`, plus `text` (or `textUnavailable`) with `includeText` |
| `job.failed` | `{ jobId, jobType, recordingId, error }`. Cancellations are not failures |
| `webhook.test` | `{ subscriptionId, message }`; only from `POST /:id/test` |
| `automation.notify` | `{ ruleId, ruleName, recordingId, steps: [{ index, type, status, resultRef }] }`; only from a rule's `notify_webhook` step, to that one subscription |

Request: `POST` with `Content-Type: application/json`, `User-Agent: OpenPlod-Webhooks/1`, `OpenPlod-Event-Id`, `OpenPlod-Delivery-Id`, `OpenPlod-Event-Type`, `Idempotency-Key` (= event id), and `OpenPlod-Signature`. Body:

```json
{ "schemaVersion": "1", "id": "<event id>", "type": "recording.transcribed", "createdAt": "…", "deliveryId": "<delivery id>",
  "data": { "recordingId": "…", "transcriptVersionId": "…", "provider": "mistral", "model": "voxtral-mini-latest", "current": true } }
```

The event id is derived from the event type and its subject (for example the transcript version), so the same fact is recorded once. Each (event, subscription) pair has one delivery id; retries and redeliveries reuse both. Deduplicate on `OpenPlod-Event-Id`.

**Signature.** `OpenPlod-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of `"<t>.<raw body>"` keyed with the subscription secret (`whsec_…`, used as given). Verify against the raw request bytes before parsing JSON:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyOpenPlod(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header).split(',').map(part => part.split('=', 2)))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex')
  const given = String(parts.v1 ?? '')
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

// Express: app.post('/openplod', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyOpenPlod(req.body.toString('utf8'), req.get('OpenPlod-Signature'), process.env.OPENPLOD_WEBHOOK_SECRET)) return res.sendStatus(401)
//   const event = JSON.parse(req.body); /* skip if event.id was already processed */ res.sendStatus(204)
// })
```

**Delivery.** Each attempt has a 10-second timeout and refuses redirects. Response bodies are never stored. Delivery `status` is:

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for its first or next automatic attempt |
| `delivering` | An attempt is in progress |
| `delivered` | The endpoint answered 2xx |
| `failed` | Non-2xx, or a connection that provably never opened (refused, DNS, certificate). Retried automatically with backoff of 30 s × 2^(n−1), capped at 1 hour, for up to 6 attempts; then `failed` |
| `unknown` | Timeout or connection reset after the request may have been sent, or the server stopped mid-request. Not retried automatically: the endpoint may have processed it. Redeliver manually if needed |
| `blocked` | Local-only mode is on and the URL is not loopback. Nothing was sent |
| `skipped` | The subscription was disabled or removed before the attempt |

Each attempt is recorded as `{ attempt, trigger: "auto" | "manual", startedAt, finishedAt, outcome, statusCode, error, durationMs }`. After 5 deliveries in a row end `failed`, the subscription is disabled with a `disabledReason`; enable it again with `PATCH { "enabled": true }`. Redelivery needs an enabled subscription (`409 webhook_disabled`) and a delivery that is not in progress (`409 delivery_in_progress`). Pending deliveries are attempted right after the event is recorded and by a sweep every 15 seconds. Delivery history is not pruned yet.

Errors: `400 invalid_input`/`invalid_json`, `404 webhook_not_found`/`delivery_not_found`, `409` as above. Webhook secrets are stored in the vault database without the vault-key encryption used for provider keys, and are included in unencrypted backups.

## Automation Rules

`/api/v1/automations` holds opt-in rules that act on newly imported recordings, their run history, and reviewed tasks. See [automation.md](automation.md#rules) for the user guide and safety model.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/automations/catalog` | `{ sources, recordingTypes, templates, connectors }` for building forms |
| GET | `/automations/rules` | All rules, oldest first |
| POST | `/automations/rules` | Create (`201`); `enabled` defaults to `false` |
| POST | `/automations/rules/preview` | Preview an unsaved rule body; nothing runs |
| GET | `/automations/rules/:id` | One rule |
| PATCH | `/automations/rules/:id` | Any rule fields plus the current `revision` (`409 revision_conflict` when stale) |
| DELETE | `/automations/rules/:id` | Delete the rule; its run history is kept, and in-flight runs stop at their next step |
| GET | `/automations/rules/:id/preview` | Preview the saved rule |
| GET | `/automations/rules/:id/runs?limit=50` | That rule's runs, newest first (1-200) |
| GET | `/automations/runs?limit=50` | All runs, newest first |
| GET | `/automations/runs/:id` | One run with its steps |
| POST | `/automations/runs/:id/retry` | Retry the failed, unknown, and skipped steps of a `failed` or `cancelled` run (`409 run_not_retryable` otherwise) |

```json
{
  "name": "Meetings from the Plaud",
  "enabled": true,
  "trigger": { "type": "recording.imported", "sources": ["plaud"], "recordingTypes": ["meeting"], "tag": null, "minDurationSeconds": 300 },
  "actions": [
    { "type": "transcribe", "provider": "mistral", "profileId": null },
    { "type": "generate_document", "template": "meeting", "folderId": null },
    { "type": "add_tags", "tags": ["auto"] },
    { "type": "add_to_collection", "collectionId": "…" },
    { "type": "notify_webhook", "subscriptionId": "…" }
  ],
  "acknowledgements": ["audio:mistral", "text:mistral", "webhook:n8n.example.com"]
}
```

- **Trigger.** Only `recording.imported`. Filters are optional and all must match: `sources` (`plaud` = source provider Plaud, `upload` = uploaded file, `mobile` = arrived from a paired phone), `recordingTypes`, `tag` (case-insensitive, on the recording's tags), and `minDurationSeconds` (an unknown duration never matches a minimum). Rules run only for recordings imported after the rule is enabled; nothing runs retroactively.
- **Actions** (1-8, run in order): `transcribe` (optional `provider` and/or `profileId`; provider fallback is disabled so only the acknowledged provider is used), `generate_document` (template, optional folder; titled "<recording> - <template label>"), `add_tags` (1-16), `add_to_collection`, `notify_webhook` (a targeted `automation.notify` event to one subscription). Profiles, folders, and webhooks named in actions must exist when the rule is saved (`400 profile_not_found`, `folder_not_found`, `webhook_not_found`). A missing collection makes that step `skipped` at run time.
- **Acknowledgements.** Every non-local destination an action would send data to with today's settings must be acknowledged on the rule before it can be enabled (`400 acknowledgement_required` lists the missing keys): `audio:<speech provider>` for `transcribe`, `text:<documents provider>` for `generate_document`, `webhook:<host>` for a non-loopback `notify_webhook`. Whisper.cpp needs no acknowledgement for audio, and Ollama none for text (in rules, a loopback custom endpoint still counts as external). A configuration problem, such as an invalid profile, is `400 rule_invalid`.
- **Run-time checks.** When each step runs, the acknowledgement and local-only mode are checked again against the settings at that moment. A step whose provider changed to one the rule was not approved for, or that local-only mode now blocks, fails with that reason and nothing is sent. The transcription job itself also passes the normal privacy check and the [cost gate](#cost-confirmation); a rule cannot confirm a cost, so with a budget or threshold set, a transcription that needs confirmation fails without sending.
- **Idempotency.** A run is unique per (rule, recording), and every step has a stable id derived from (rule, recording, step index). The step id is the document generation's idempotency key and the notification event's subject, so repeated events, sweeps, and restarts never duplicate a job, document, tag, or event. A `transcribe` step joins a transcription already queued for the recording instead of starting another (its `detail` says so). A retried `generate_document` uses a fresh key derived from the step id and attempt number.
- **Waiting.** `transcribe` queues a `process-recording` job and waits until the transcript version exists; `generate_document` waits for an active transcription or fails when there is no transcript. Waiting runs continue on the transcription or failure event and on a sweep every 15 seconds.
- **Kill switch.** Disabling or deleting a rule marks its pending and waiting steps `skipped` and the run `cancelled`.

Run: `{ id, ruleId, ruleName, recordingId, recordingTitle, status, createdAt, updatedAt, steps }`, with `status` `running`, `waiting`, `complete`, `failed`, or `cancelled`. Step: `{ id, index, type, status, detail, resultRef, attempts, updatedAt }`, with `status` `pending`, `running`, `waiting`, `done`, `skipped`, `failed`, or `unknown`. `resultRef` is the job, document, collection, or webhook event id. A step left `running` by a stopped process returns to `pending` on start; an interrupted generation is `unknown`, because the provider may have processed and billed it.

Preview response:

```json
{ "matches": [{ "id": "…", "title": "Standup.m4a", "sourceProvider": "plaud", "sourceTransport": "folder", "recordingType": "meeting", "durationSeconds": 900, "recordedAt": "…" }],
  "totalMatches": 14, "scanned": 312,
  "requirements": [{ "key": "audio:mistral", "kind": "audio", "target": "mistral", "label": "Mistral Voxtral receives the audio", "local": false, "acknowledged": true, "step": 0 }],
  "missingAcknowledgements": [], "localOnly": false, "blockedByLocalOnly": [],
  "estimatedCost": { "status": "unknown", "amount": null, "currency": null, "reason": "…" },
  "problems": [], "note": "Rules run only for recordings imported after the rule is enabled. …" }
```

`matches` lists the first 25 matching active recordings among the latest 2,000 (`scanned`); they show what the filters would match and are not processed. The preview does not price a rule (`estimatedCost.status` is always `unknown`); use `POST /api/ai-settings/estimate` for a transcription estimate.

## Reviewed Tasks and Connectors

Action items become local task drafts that a person edits and approves one by one, then explicitly exports to Todoist, Linear, or Notion. Nothing is posted automatically. See [automation.md](automation.md#reviewed-tasks).

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/automations/tasks?status=&recordingId=` | Up to 500 drafts, newest first; `status` is `draft`, `approved`, or `dismissed` |
| POST | `/automations/tasks` | `{ title, notes?, owner?, dueDate?, recordingId? }`, `201`, source `manual` |
| POST | `/automations/tasks/extract` | `{ recordingId, items? }` → `{ created, existing }` |
| GET | `/automations/tasks/:id` | One draft with its `exports` |
| PATCH | `/automations/tasks/:id` | `{ revision, title?, notes?, owner?, dueDate?, status? }` |
| DELETE | `/automations/tasks/:id` | Only for a task never (possibly) exported; otherwise `409 task_exported`, dismiss it instead |
| POST | `/automations/tasks/export` | `{ connector, taskIds (1-50), confirm: true, retryUnknown? }` |
| GET | `/automations/tasks/calendar.ics?ids=` | iCalendar file, one all-day event per dated, non-dismissed task (all tasks when `ids` is empty). Generated locally; nothing is sent |
| GET | `/automations/tasks/connectors` | `{ todoist: { configured }, linear: { configured, teamId }, notion: { configured, databaseId, titleProperty, dateProperty } }` |
| PUT | `/automations/tasks/connectors` | Any of `todoistApiToken`, `linearApiKey`, `linearTeamId`, `notionApiKey`, `notionDatabaseId`, `notionTitleProperty`, `notionDateProperty`. An empty string clears a value. Tokens are never returned |

```json
{ "id": "…", "recordingId": "…", "title": "Send the revised budget to finance", "notes": "", "owner": "Ana", "dueDate": null, "dueText": "next Friday",
  "source": "extracted", "status": "approved", "revision": 3, "createdAt": "…", "updatedAt": "…",
  "exports": [{ "connector": "todoist", "status": "created", "remoteId": "8123…", "remoteUrl": "https://todoist.com/…", "error": null, "attempts": 1, "updatedAt": "…" }] }
```

- **Extract.** `items` (up to 100 `{ text, owner?, due? }`) are action items the client just showed, for example from a saved structure; without `items`, the recording's saved analysis tasks are used (`404 no_action_items` when there are none). Repeating an extraction never duplicates a draft for the same recording and title. Only an explicit `YYYY-MM-DD` becomes `dueDate`; spoken dates stay in `dueText` for a person to resolve.
- **Review.** Titles are 1-500 characters, notes up to 4,000. `PATCH` needs the current `revision` (`409 revision_conflict`). Editing the content of an approved task returns it to `draft`.
- **Export.** Only `approved` tasks are sent; others come back `skipped`. Each (task, connector) pair is claimed before the network call, so an approved task is created at most once per connector. Result `status` per task: `created` (2xx with an id), `failed` (a 4xx or a connection that never opened; exporting again retries it), `unknown` (timeout, 5xx, or 2xx without an id: the task may exist), `pending` (another export is in progress), `skipped`. An `unknown` export is resent only with `retryUnknown: true`, which can create a duplicate; check the service first. Local-only mode refuses export (`403 local_only`); a connector without credentials is `400 connector_not_configured`. Requests use a 15-second timeout and refuse redirects. Todoist receives `X-Request-Id` = the export id.
- **Credentials** are stored in the settings table without the vault-key encryption used for provider keys, and are included in unencrypted backups.

The Todoist, Linear, and Notion adapters are contract-tested against recorded request shapes only; they have not been verified against the live services.

## Mobile API

All routes below are under `/api/mobile`. They always require a token (`503` when no pairing token is configured at all, `401` otherwise) and send `Cache-Control: no-store`. The user and integrator guide is [mobile-sync.md](mobile-sync.md).

| Method | Path | Permission | Behavior |
| --- | --- | --- | --- |
| GET | `/health` | any | `{ vault: "ready" }` |
| POST | `/plaud/session` | any | Plaud SDK session for the phone, from the desktop's Plaud developer credentials; `503` when that fails |
| GET/PATCH | `/clients/me` | any | The caller's own client record; `PATCH { name?, platform? }` |
| GET/POST | `/clients` | desktop/api | List clients; issue a new one |
| PATCH | `/clients/:id` | desktop/api | `{ name?, permissions? }` |
| POST | `/clients/:id/revoke` | desktop/api | Revoke |
| POST | `/clients/:id/rotate` | desktop/api | New token for the client |
| POST | `/uploads` | `upload` | Start or resume a resumable transfer |
| GET (or HEAD) | `/uploads/:id` | `upload` | Committed offset |
| PUT | `/uploads/:id` | `upload` | Append one chunk |
| POST | `/uploads/:id/complete` | `upload` | Verify, import, acknowledge |
| DELETE | `/uploads/:id` | `upload` | Cancel the caller's own open transfer |
| POST | `/recordings` | `upload` | Single-request upload (older clients) |
| GET | `/changes?since=&limit=` | `sync` + `read` | Change feed |
| POST | `/changes` | `sync` + `write` | Push metadata edits |

A missing permission is `403 forbidden`. Client management from a paired device is `403` ("Manage paired devices from the desktop app").

### Paired Mobile Clients

`POST /api/mobile/clients { name?, platform?, permissions? }` returns `201 { client, token }`. The token (256 random bits, base64url) is shown once; only its SHA-256 is stored. A client that has never authenticated stops working one hour after issue (`pairingExpiresAt`); its first authenticated request clears the expiry. New clients get all four permissions unless `permissions` is given.

```json
{ "id": "…", "name": "Pixel 8", "platform": "android", "permissions": ["read", "write", "upload", "sync"], "legacy": false,
  "createdAt": "…", "pairingExpiresAt": null, "lastSeenAt": "…", "lastSuccessfulSyncAt": "…", "revokedAt": null }
```

| Permission | Allows |
| --- | --- |
| `read` | `GET`/`HEAD`/`OPTIONS` on `/api/*` outside `/api/mobile`; with `sync`, reading the change feed |
| `write` | Other methods on `/api/*` outside `/api/mobile`; with `sync`, pushing metadata edits |
| `upload` | `/api/mobile/uploads*` and `/api/mobile/recordings` |
| `sync` | `/api/mobile/changes` (with `read` or `write`) |

`lastSeenAt` is the last authenticated request (written at most once a minute), not a presence signal. `lastSuccessfulSyncAt` is set by a completed upload, a single-request upload, a change-feed read, or a push. Names are up to 80 characters; an unknown permission is `400`; an unknown client id is `404`.

**Revoke** takes effect on the next request. **Rotate** issues a new token and the old one stops working immediately; the new token again expires after an hour if unused. A revoked client cannot be rotated; pair again. The legacy client (id `legacy`) stands for the global pairing token used from the network by phones paired before per-device credentials; it is listed whenever the global token is set. Revoking it never locks out the desktop, which reaches its own service over loopback. Rotating it revokes it and issues a new per-device credential with the same name and permissions. If the desktop's global token changes, the legacy row is reset. In Docker or remote-browser setups the desktop UI is not on loopback, so administer clients with `OPENPLOD_API_TOKEN`.

### Resumable Uploads

Transfers are byte-offset resumable, verified by SHA-256 per chunk and for the whole file, and scoped to the client that created them (another client gets `404 transfer_not_found`).

1. `POST /uploads { fingerprint, size, filename, metadata? }`. `fingerprint` is the lowercase hex SHA-256 of the whole file, `size` its length in bytes (up to 2 GiB), `filename` must have a supported audio extension. `metadata` may hold `sourceProvider` (`plaud`, `upload`, otherwise `opennotes`), `sourceRecordingId`, `recordedAt`, `durationMs`, `context`, `recordingType`. Response `{ transferId, offset, size, fingerprint, state, maxChunkBytes, recordingId }` plus an `Upload-Offset` header; `201` for a new transfer. The same client, fingerprint, and size returns the existing transfer and its committed offset, or `state: "complete"` once done (unless that recording has since been purged, which starts a new transfer).
2. `PUT /uploads/:id` with the raw bytes, `Content-Range: bytes <start>-<end>/<size>` (inclusive end) and `X-Chunk-SHA256: <hex of this chunk>`. A chunk is at most `maxChunkBytes` (8 MiB) and must start at the committed offset. It is written and fsynced before the offset advances. Response: the transfer state with the new `offset`.
3. `POST /uploads/:id/complete`. The server re-hashes the staged file, imports it with the expected fingerprint, records the acknowledgement, deletes the staging file, and queues processing for a new recording. Response `{ transferId, recordingId, fingerprint, added }`, `201` when the recording was added and `200` when the vault already had it. Completing again returns the same acknowledgement.

Keep the local audio until the acknowledgement's `fingerprint` equals the local SHA-256.

| Error | Meaning and recovery |
| --- | --- |
| `409 offset_mismatch` | The chunk does not start at the committed offset. `data.offset` and `Upload-Offset` give the offset to resume from |
| `422 chunk_checksum_mismatch` | `X-Chunk-SHA256` is missing or wrong. Resend the chunk from `data.offset` |
| `400 invalid_range`, `416 invalid_range`, `400 length_mismatch` | Malformed `Content-Range`, a range outside the transfer, or a body length that differs from the range |
| `413 chunk_too_large`, `413 too_large` | Chunk over 8 MiB, file over 2 GiB |
| `409 incomplete` | `complete` before all bytes arrived; `data.offset` says where to continue |
| `422 fingerprint_mismatch` | The assembled file does not match `fingerprint`. The staged bytes are deleted and the offset reset to 0; upload again from the start |
| `409 import_conflict` | The vault refused the import |
| `409 transfer_complete` | Appending to a completed transfer |
| `400 invalid_fingerprint`, `invalid_size`, `unsupported_format`, `invalid_metadata` | Bad `POST /uploads` input |

A chunk the server already committed is acknowledged again without being rewritten, so resending after a lost response is safe. After an interruption, ask `GET /uploads/:id` (or repeat `POST /uploads`) for the committed offset; it can be lower than the client's own count if the server lost an unsynced tail. Open transfers untouched for 48 hours are deleted with their staged bytes; completion records are kept 30 days. `DELETE /uploads/:id` cancels an open transfer (`{ cancelled: true }`) and never undoes a completed import (`{ cancelled: false }`).

`POST /api/mobile/recordings` (multipart: `file`, optional `fingerprint`, `duration_ms`, `source_provider`, `source_recording_id`, `recorded_at`, `context`, `recording_type`) is the single-request upload kept for older clients; it returns `{ recordingId, fingerprint, added }`. Clients fall back to it when `POST /uploads` answers `404` or `405`.

### Change Feed and Metadata Push

`GET /api/mobile/changes?since=<cursor>&limit=<1-500, default 200>` returns `{ cursor, hasMore, changes, tombstones }`. Start without `since` (or with `0`), apply the page, persist `cursor`, and repeat while `hasMore` is true.

```json
{ "cursor": "1842", "hasMore": false,
  "changes": [
    { "type": "recording", "id": "…", "seq": 1840, "revision": 7, "retentionState": "active", "deletedAt": null, "title": "Standup", "recordedAt": "…",
      "recordingType": "meeting", "context": null, "notes": null, "tags": ["team"], "status": "complete", "fingerprint": "…", "durationSeconds": 912,
      "sourceProvider": "plaud", "sourceRecordingId": "…", "transcriptHead": { "versionId": "…", "origin": "generated" } },
    { "type": "purged", "id": "…", "seq": 1842, "revision": 4 } ],
  "tombstones": [{ "seq": 1842, "recordingId": "…", "event": "purge", "revision": 4, "fingerprint": "…", "sourceProvider": "plaud", "sourceRecordingId": "…", "at": "…" }] }
```

- `changes` has one entry per recording touched after the cursor, with its **current** state, not every intermediate edit. `title` is the filename without its extension. `transcriptHead` is a pointer; fetch text with `GET /api/recordings/:id/transcript/versions`.
- `tombstones` are the `trash`, `restore`, and `purge` events in the page's range, in order, with timestamps and source identity, so a peer can match a copy it imported under another id.
- The cursor is opaque. `410 cursor_expired` means it is invalid or ahead of this vault (for example after restoring a backup): resynchronize from `0`. The feed log is not compacted yet.

`POST /api/mobile/changes { "changes": [...] }` (at most 200) applies queued metadata edits:

```json
{ "changes": [{ "changeId": "c-0193…", "recordingId": "…", "baseRevision": 7, "fields": { "title": "Standup with design", "tags": ["team", "design"] } }] }
```

Only `title` (1-200 characters; the file extension is kept), `context` (up to 5,000, or `null`), `notes` (up to 20,000, or `null`), `tags` (up to 50, each up to 60 characters), `recordingType`, and `recordedAt` (a date) can be changed. Response `{ results, cursor }`, one result per change, each applied in its own transaction:

| `status` | Meaning |
| --- | --- |
| `applied` | Written; `revision` is now `baseRevision + 1` |
| `conflict` | `baseRevision` is stale. **Nothing was written.** `current` is the recording's current feed entry; rebase the pending edit onto it or ask the user, then resubmit with a new `baseRevision` |
| `trashed` | The recording is in Trash; restore it first |
| `not_found`, `invalid` | Not applied; `error` explains |

An `applied` result is remembered per client and `changeId`, so retrying a request whose response was lost returns `applied` again instead of a false conflict. Transcripts, audio, and processing results are desktop-owned and cannot be pushed. A malformed body (not a list, or more than 200) is `400`.

## Vault Backup and Restore

`/api/vault` creates, verifies, and restores full vault archives (optionally encrypted with a passphrase). Long operations return `202` with an operation that is polled; one runs at a time (`409` otherwise). Full details: [backup-and-restore.md](backup-and-restore.md#api).

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/api/vault/status` | Data, database, library, and backups paths; schema metadata; whether TLS is configured; last import-recovery report |
| GET | `/api/vault/recovery` | Last import-recovery report (see [recovery.md](recovery.md)) |
| GET | `/api/vault/backups` | `{ directory, files: [{ name, path, bytes, modifiedAt, encrypted }] }` for `.tar` and `.tar.opbk` archives |
| POST | `/api/vault/backups` | `{ passphrase?, directory? }`; an absolute directory, default `OPENPLOD_BACKUP_DIR` or `<data>/backups`. With a passphrase the archive is encrypted and includes the vault key |
| POST | `/api/vault/backups/verify` | `{ path, passphrase? }`; `path` is a file name in the backups folder or an absolute path (`404` when missing) |
| POST | `/api/vault/restore` | `{ path, targetDirectory, passphrase?, confirmOverwrite? }`; restores into an absolute target folder, never over the live vault |
| GET | `/api/vault/operations/:id` | `{ id, kind, state: running \| complete \| failed, startedAt, finishedAt, progress, result, error, code }`; `code` is `wrong_passphrase`, `target_not_empty`, or `failed` |

Unencrypted archives drop the provider keys that are encrypted at rest (Mistral, Deepgram, OpenAI, AssemblyAI, Anthropic, OpenWhistle). Other stored secrets (Gemini and custom-endpoint keys, connector tokens, webhook secrets) are not removed in this build.

## Recording Routes

`/api/recordings` is the recording library used by the app. Mutations that take a `revision` reject a stale one with `409`.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/api/recordings` | `limit` (1-100, default 20), `offset`, `status`, `type`, `search` (filename), `retention=trash`, `collection=<id>`. Rows add `hasTranscript` and `collectionIds`; `pagination { total, limit, offset, hasMore }` |
| GET | `/api/recordings/:id` | Recording with its current transcript, summary, and extracted tasks |
| PATCH | `/api/recordings/:id` | `{ revision, title?, recordedAt?, recordingType?, context?, notes?, tags? }`; the title keeps the file extension |
| DELETE | `/api/recordings/:id` | Move to Trash; `?permanent=true&confirm=true` purges permanently |
| POST | `/api/recordings/:id/restore` | Restore from Trash |
| GET | `/api/recordings/:id/audio` | Audio stream with HTTP `Range` support (`206`, `416`) |
| POST | `/api/recordings/import` | Multipart `file` upload (plus optional `duration_ms`, `recording_type`, `context`, `source_*`, `recorded_at`), or JSON `{ paths }` inside the configured Plaud sync folder. New recordings are queued for processing |
| POST | `/api/recordings/:id/replace-audio` | Multipart `file` and `revision`; replaces the audio and queues processing of the new file |
| POST | `/api/recordings/sync` | Scan the configured sync folder now |
| GET | `/api/recordings/stats/summary` | Counts by status and type and total duration of active recordings |
| GET/POST/DELETE | `/api/recordings/:id/bookmarks[/:bookmarkId]` | Timestamp bookmarks: `POST { id (UUID), seconds, label (1-160) }`, idempotent by id |
| PATCH | `/api/recordings/:id/transcript` | `{ fullText, segments?, revision? }`; saved as an edited version |
| GET | `/api/recordings/:id/transcript/versions` | All versions with text and provenance, newest first |
| GET | `/api/recordings/:id/transcript/compare?before=&after=` | Diff two versions |
| POST | `/api/recordings/:id/transcript/versions/:versionId/promote` | `{ revision? }`; make a stored version current. The replaced version stays in history |
| POST | `/api/recordings/:id/transcript/operations` | `{ operations, revision?, preview? }`: `rename-speaker`, `merge-speakers`, `split-segment`, `merge-segments`, `replace`. `preview: true` returns the result without saving; otherwise one gesture is one new version |
| POST | `/api/recordings/:id/transcript/cleanup` | `{ punctuation?, paragraphs?, removeFillers?, headings? }`; proposal from the summaries provider, plus `sourceHash` |
| POST | `/api/recordings/:id/transcript/cleanup/save` | `{ text, sourceHash, revision? }`; `409 source_changed` when the transcript changed since review |
| POST | `/api/recordings/:id/transcript/translate` | `{ targetLanguage }`; proposal plus `sourceHash` |
| POST | `/api/recordings/:id/transcript/translate/save` | `{ text, targetLanguage, sourceHash }`; stored as a `translation:<lang>` version, never promoted over the original |
| GET/POST/PATCH/DELETE | `/api/recordings/custom-actions[/:actionId]` | Saved reusable AI instructions |
| POST | `/api/recordings/:id/transcript/custom-actions/:actionId` | Run one against the current transcript; returns a preview only |
| POST | `/api/recordings/:id/analyze` | Summary and tasks; see [Processing Jobs](#processing-jobs) |
| POST | `/api/recordings/:id/reprocess` | Transcribe again; see [Processing Jobs](#processing-jobs) and [Cost confirmation](#cost-confirmation) |
| POST | `/api/recordings/:id/forward` | Forward to OpenWhistle (`202 { runId }`) when configured |
| POST/GET | `/api/recordings/batch/estimate`, `/batch`, `/batch/:batchId`, `/batch/:batchId/cancel` | See [Batch transcription](#batch-transcription) and [Batch document generation](#batch-document-generation) |

Cleanup, translation, custom actions, and structure extraction use the summaries provider (`analysisProvider` and its fallbacks). Provider failures are `503` with a `code` (`provider_unavailable`, `provider_failed`, …); a transcript over the size limit is `413 transcript_too_large`.

## System and Legacy Routes

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | `{ status: "ok", jobs }`; outside `/api`, so it needs no token |
| GET | `/api/info` | Name, version, speech engine availability |
| GET | `/api/engines` | Speech engine availability from saved keys and local binaries |
| GET | `/api/settings` | Legacy settings (sync folder, auto-transcribe/summarize/import, OpenWhistle) with key-presence flags |
| PUT | `/api/settings/:key` | `{ value }` for one allowed legacy key; `transcriptionEngine` also resets model, diarization, vocabulary, and prompt |
| PATCH | `/api/settings` | `{ key: value, ... }` for several legacy keys in one transaction. Every key is validated first; one unknown key or rejected value returns `400` and writes nothing. The Settings page saves through this route |
| GET | `/api/search?q=` | Legacy transcript search (2+ characters). Prefer `/api/v1/search` |
| GET | `/api/transcripts?offset=&source=` | Active recordings with a transcript, 30 per page, with a 200-character excerpt |
| GET/POST/PATCH | `/api/jobs[...]` | Legacy job controls; see [Processing Jobs](#processing-jobs) |
| `*` | `/api/plaud/*` | Plaud device (Bluetooth), cloud import, identity, authorization, environment, and folder import routes used by the app. Device authorization approval and listing are accepted only from this computer (loopback); request bodies are limited to 16 KB. See [README.md](../README.md) |

Plaud extraction and recording ownership are not routed through the organizer. See [README.md](../README.md) for hardware and privacy limitations.

