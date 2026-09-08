# OpenPlod API

The 0.5 development build adds [AI provider settings, connection checks, and durable job controls](ai-providers.md#apis). These routes use the same authentication below. Provider live acceptance and spending controls remain open release gates.

The organizer API is rooted at `/api/v1`. It runs inside the existing desktop service, normally `http://127.0.0.1:3487`. Existing recording and transcript endpoints remain backward compatible.

## Authentication and Exposure

Send `X-OpenPlod-Token` with the desktop pairing token, or with a separately configured `OPENPLOD_API_TOKEN`. The native app automatically configures its pairing token. A source-run server with neither token configured remains unauthenticated for local development; do not bind it to a shared network in that state.

Tokens are credentials, not public URLs. Keep them out of query strings, logs, source, and screenshots. The native app uses private-LAN HTTP for pairing, not internet-facing TLS. Use HTTPS for remote API clients. API responses disable caching.

## Contract

Successful responses use `{ "success": true, "data": ... }`. Failures use `{ "success": false, "code": "revision_conflict", "error": "..." }`.

| Status | Meaning |
| --- | --- |
| 200 / 201 | Successful operation / created resource |
| 400 | Invalid JSON, unknown fields, missing confirmation, or invalid input |
| 401 | Missing or invalid API/pairing token |
| 404 | Document, folder, active recording, version, or destination unavailable |
| 409 | Stale revision, duplicate request key with different content, cycle, or invalid retention state |
| 410 | The document's 30-day restore window expired |
| 413 | Request body exceeds 4 MB; Markdown itself is limited to 512 KB of UTF-8 |
| 503 | Destination configuration is invalid or unavailable |

IDs and idempotency keys are UUIDs. Mutable resources have a positive integer `revision`. Read first, then submit that revision with updates, moves, Trash, restore, or purge. A conflict does not overwrite newer data. Titles are 1-180 characters without control characters or path separators.

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
| POST | `/documents` | `{ title, content?, folderId?, idempotencyKey }` |
| GET | `/documents/:id` | Complete note including content, source references, revision, retention dates |
| PATCH | `/documents/:id` | `{ revision, title?, content?, folderId?, starred? }` |
| DELETE | `/documents/:id` | `{ revision }`; move to 30-day Trash |
| POST | `/documents/:id/restore` | `{ revision }`; restore during the retention window |
| POST | `/documents/:id/purge` | `{ revision, confirm: true }`; permanently remove a trashed note and history |
| GET | `/documents/:id/versions` | Version summaries, newest first; `offset` paginates in groups of 30 |
| GET | `/documents/:id/versions/:versionId` | Historical title and Markdown |
| POST | `/documents/:id/versions/:versionId/restore` | `{ revision }`; restore content as a new revision |
| GET | `/documents/:id/export?format=md` | Download exact saved Markdown; `format=json` includes metadata |
| GET | `/transcripts/:recordingId` | Read source metadata and current transcript; optional `versionId` selects history |
| POST | `/documents/from-transcript` | `{ recordingId, versionId?, folderId?, title? }`; independent, provenance-linked snapshot |
| POST | `/documents/generate` | Mistral generation, SSE `progress`, `result`, or `error` events; no note saved yet |
| GET | `/generations/:id` | Private generation result and timestamped processing trace |
| POST | `/generations/:id/save` | `{ folderId? }`; save reviewed AI output once as a new note |
| GET | `/destinations` | Configured destination ID, name, and host only; no secrets or full URL |
| POST | `/documents/:id/send` | `{ destinationId, revision, confirm: true, idempotencyKey }` |
| GET | `/documents/:id/deliveries` | Latest 30 delivery attempts, without provider response bodies |

`GET /documents` accepts:

- `view=all|starred|trash` (default `all`, excluding Trash).
- `folderId=<UUID>` for direct members only, or `folderId=inbox` for unfiled notes.
- `q=<text>` for indexed full-text token-prefix search across titles and Markdown.
- `sort=updated|title`, `offset=0`, and `limit=30` (maximum 100).

Response: `{ documents: [...], total, offset, limit }`. Summaries include a short excerpt, not the entire Markdown body. Up to 1,000 folders and 32 nesting levels are supported.

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

### Mistral Documents

The UI's **Create document** action generates structured Markdown using `mistral-small-latest` and the Mistral key in desktop Settings (or `MISTRAL_API_KEY`). It does not call the snapshot endpoint. A request contains `{ idempotencyKey, recordingId, versionId?, title, style?, instructions? }`, where `style` is `notes`, `meeting`, or `brief`. The server retrieves the selected saved transcript and sends its text, title, and optional writing instructions to Mistral. Original audio is not sent by this operation.

Generation streams truthful workflow stages and returns a reviewable draft. Only `/generations/:id/save` creates a note. Provider errors, cancellation, invalid output, and the 90-second timeout never fall back to a copied transcript. Inputs above 100 KB are rejected without truncation. At most two generations run concurrently per desktop service. Reusing a completed request ID returns its existing result; pending or failed IDs are not automatically retried. Failed/restarted requests require an explicit new generation.

The saved document preserves source recording/version references, a generated initial version, provider/model provenance, and a private generation trace. Subsequent user edits use normal note revisions. Uncommitted generation drafts older than 24 hours are cleaned up when another generation starts; saved traces are removed when their document is permanently purged. These AI outputs can contain mistakes and should be reviewed before saving or sending.

Note history includes saved content and metadata changes. Restoring history copies its title and Markdown into a new revision; it does not rewind the current folder, star state, or source provenance. Expired note Trash is purged when the backend starts. This is retention cleanup, not forensic secure erasure.

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

The existing `/api/recordings`, `/api/transcripts`, `/api/plaud`, and `/api/mobile` routes are unchanged apart from accepting the optional API token through the shared authentication gate. Plaud extraction and recording ownership are not routed through the organizer. See [README.md](../README.md) for hardware and privacy limitations.
