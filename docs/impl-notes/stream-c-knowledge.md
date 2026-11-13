# Stream C - Knowledge workspace (0.7.0 KB-01 to KB-07)

Implementation notes for the unfinished 0.7.0 knowledge items. Nothing here marks a roadmap
checkbox complete; the 0.7.0 exit gate has not been run. CHANGELOG, README, and ROADMAP were
deliberately not edited by this stream.

## Implemented

| Item | What | Where | Tests |
| --- | --- | --- | --- |
| KB-01 | Recording collections: additive `recording_collections` / `recording_collection_items`, CRUD with revision checks and case-insensitive unique names, add/remove recordings, Trash-aware counts, purge removes membership (trigger). `GET /api/recordings?collection=` filter and `collectionIds` on list rows. Library sidebar group, collection header (rename, delete), "Add to collection" submenu in the row dropdown and right-click menu | `src/knowledge/collections.ts`, `src/knowledge/schema.ts`, `src/api/knowledge.ts`, `src/api/recordings.ts`, `web/src/components/RecordingCollections.tsx`, `web/src/pages/Dashboard.tsx`, `web/src/components/Layout.tsx` | `src/knowledge/collections.test.ts`, `src/library/recording-library.test.ts` |
| KB-02 | Export attachments (audio and/or exact cited transcript version into `attachments/`, manifest-tracked with SHA-256, same conflict and foreign-file rules, `overwriteAttachments`). Export folder chosen in the app (`PUT /api/v1/exports/markdown/folder`, `confirm: true`, absolute existing folder outside the vault, not a drive root; `OPENPLOD_EXPORT_DIR` wins and is reported as locked). Tauri `pick_export_folder` (rfd `pick_folder`, refuses the vault and its parents), wired in the desktop invoke handler; MarkdownExportDialog uses it on desktop and a text field in the browser | `src/organizer/markdown-export.ts`, `src/organizer/schemas.ts`, `src/api/organizer.ts`, `src-tauri/src/desktop_exports.rs`, `src-tauri/src/lib.rs`, `web/src/components/MarkdownExportDialog.tsx` | `src/organizer/markdown-export-attachments.test.ts`; Rust `export_folder_must_be_outside_the_vault` |
| KB-03 | Pinned recordings and a project note per conversation (`ai_conversations.pinned_recording_ids`, `context_note`, settable before the first question; `GET /api/ai/conversations/:id/context`). Pins are always included in full; the note is sent as `projectContext`, declared untrusted and never citable. Up to three `followUps` in the structured answer, cleaned server-side, shown as chips that only fill the composer | `src/organizer/recording-ai.ts`, `src/organizer/recording-ai-types.ts`, `src/api/recording-ai.ts`, `web/src/pages/AiPage.tsx` | `src/organizer/recording-ai-context.test.ts` |
| KB-04 | Hybrid retrieval: passages from the current transcript version of active recordings (segment runs with index range and times from data) and active notes; FTS5 + vectors in SQLite (float32 BLOB per passage and model, source SHA-256), incremental indexing, triggers that drop cache on Trash, purge, new current version, note edit/trash/purge. Embedding providers: Ollama (only when installed), built-in lexical fallback, OpenAI/Mistral only after explicit opt-in confirmed in the same request and never in local-only mode. `GET /api/v1/search`, `/search/status`, `/search/settings`, `/search/reindex`. Chat without selected recordings retrieves passages across the vault and reports `sentRecordingIds` / `usedRecordingIds`; UI shows "Found in" links and citation previews with time ranges and exact version. Command palette has a Keyword / Passages mode; Settings has a search panel | `src/knowledge/retrieval.ts`, `src/knowledge/embeddings.ts`, `src/knowledge/text.ts`, `web/src/components/WorkspaceSearch.tsx`, `web/src/components/SearchIndexPanel.tsx` | `src/knowledge/retrieval.test.ts` (including the exit-gate test and a race where the source changes during embedding), `src/organizer/recording-ai-context.test.ts` |
| KB-05 | Reviewable recording title/tag suggestions (`POST /api/v1/recordings/:id/suggestions`, `consent: true`, applied only through the normal revision-checked recording PATCH; UI in the Edit tags dialog). Recurring topics: local counting of shared tags and words (`GET /api/v1/topics`), cited topic summary preview (`POST /api/v1/topics/summary`, exact-quote validation), saved as an ordinary document from the AI page Topics panel | `src/knowledge/suggestions.ts`, `web/src/components/RecordingTagsDialog.tsx`, `web/src/pages/AiPage.tsx` | `src/knowledge/suggestions.test.ts` |
| KB-06 | `Idempotency-Key` on `POST /api/recordings/:id/reprocess` and the new `POST /api/v1/jobs` (same key and request returns the same job in any state; different request is 409). Analysis (`POST /api/recordings/:id/analyze`) now runs as an `analyze-recording` queue job, listed in `/api/v1/jobs` with the analysis provider | `src/jobs/submit.ts`, `src/api/jobs.ts`, `src/api/recordings.ts`, `src/index.ts` | `src/jobs/submit.test.ts`, `src/library/recording-library.test.ts` |
| KB-07 | `OPENPLOD_MCP_SCOPES` (`read`, `write:documents`, `write:folders`, `process`, `deliver`; unknown scope fails startup), `OPENPLOD_MCP_WRITE=1` kept as `write:documents` + `write:folders`. New read tools `search`, `list_collections`, `get_collection`; `start_transcription` (process: confirm, idempotency key, dry-run plan, refuses cloud providers until `acceptCloudProvider: true`); `list_destinations`, `send_document` (deliver). Client allowlist adds collections, destinations, `search` (exact) and keeps `exports/markdown` exact, so the folder and search settings endpoints are unreachable | `src/mcp/server.ts`, `src/mcp/client.ts`, `src/mcp/index.ts` | `src/mcp/server.test.ts` |

`docs/api.md` and `docs/mcp.md` describe the new contracts.

## Decisions

- **New `src/knowledge/` module**, so stream A's `src/ai/*` is only imported, never edited.
  Knowledge settings live in their own `user_settings` key (`knowledgeConfig`), not in `aiConfig`.
- **Migrations** are additive and re-runnable: `initializeKnowledge` (called from `src/db/setup.ts`)
  uses `CREATE ... IF NOT EXISTS`; new columns on `ai_conversations` and `ai_turns` are added
  after a `PRAGMA table_info` check. Triggers are only created on tables that exist.
- **Cache invalidation by trigger, plus a query-time check.** Triggers on `recordings`
  (`retention_state` leaving `active`, delete), `transcripts` (`current_version_id`, `full_text`,
  `segments`, delete) and `note_documents` (title/content/`deleted_at`, delete) delete passages,
  FTS rows, vectors, and the per-source index record. Every search additionally joins each
  passage to an active recording whose current version is the passage's version (or an active
  note at the same revision), so a missed trigger can never surface removed text.
- **Hybrid score** = `0.5 * bm25 / best bm25 + 0.5 * max(0, cosine)` over up to 50 candidates
  from each retriever (`FTS_WEIGHT` in `retrieval.ts`). FTS uses an OR query over content words
  (English/French stopwords removed) so natural-language questions match.
- **Lexical fallback is labelled lexical.** Signed hashed bag-of-words, SMART `lnc.ltc`
  (sublinear TF on passages; IDF from `fts5vocab` on the query). Because hash collisions are
  not meaning, its vector candidates are gated to passages sharing a word. `auto` prefers an
  installed Ollama model (`nomic-embed-text`, with its `search_document:`/`search_query:` prefixes).
- **Cloud embeddings** need `embeddingProvider` set, `cloudOptIn: true` and `confirmCloud: true`
  in the same PUT, a stored key (a developer's env key is honoured like elsewhere), and a privacy
  mode that allows the provider, re-checked before each request. Otherwise the lexical index is
  used and the response `note` says why; nothing is sent.
- **Chat retrieval scope**: transcripts only (sources must be recordings to cite times and
  versions); 16 passages per question; pinned recordings are sent in full and excluded from
  retrieval; selecting recordings later in a retrieved conversation is a context change (409),
  as before. Turns store the recordings actually sent (`ai_turns.source_ids`), so a conversation
  disappears from the list once any recording it sent is in Trash, matching existing behaviour.
- **Follow-ups never fail an answer**: malformed or missing `followUps` are dropped, valid ones
  are trimmed, de-duplicated, and capped at three.
- **Export folder security**: the folder is persisted as a setting only through
  `PUT /exports/markdown/folder` with `confirm: true`; the endpoint is token-protected like all of
  `/api`, so an API-token holder can set it too, but only explicitly and never via MCP. It must be
  outside the database folder and `OPENPLOD_LIBRARY_PATH` (neither inside nor a parent).
- **Attachment identity**: audio is keyed by recording, transcripts by exact version, so one
  attachment is shared by every note citing it; a note's front matter changes when attachments
  are enabled, which shows as `updated` once.
- **Analysis through the queue**: the HTTP call waits up to two minutes and then answers `202`
  with the job id; analysis jobs get priority 5 so they run before queued transcriptions, but the
  queue is still sequential, so a running transcription delays them. Auto-summary inside a
  transcription job stays part of that job.
- **MCP `start_transcription`** always asks the vault for a dry-run plan first and refuses cloud
  providers without `acceptCloudProvider: true`; the server enforces the same rule.

## Not done / caveats

- **Topic clustering is counting, not clustering.** Topics are shared tags and shared content
  words across recent recordings (ceiling at 80% of recordings); there is no embedding-based
  clustering or multi-word phrase detection.
- **Vector search is a brute-force scan** of the current model's vectors per query (fine for
  personal vaults; not measured against the 10,000-note budget). No ANN index.
- **Indexing is lazy**: each search indexes at most 25 pending sources; there is no background
  indexer or progress UI beyond Settings "Index now" (200 sources per click).
- **Ollama availability** is cached for 30 s (15 s when unreachable) since [1.1.0 Sprint 1](../sprint-1.1.0-1.md); before that every search paid the `/api/tags` check.
- **No embedding of document passages into chat**: chat retrieval uses transcripts only.
- **Analysis cancellation** stops the job record but cannot abort an in-flight provider request
  (the analyzer takes no abort signal; `src/analysis` was left alone).
- **Idempotency keys** are kept indefinitely in `job_requests`; once the job itself is pruned
  (30 days) a replay returns `409 idempotency_expired`.
- **Browser checks**: the collection sidebar, collection view, and AI page were checked headless
  at 1440 px and 390 px. The export dialog, topic panel, palette Passages mode, and settings
  panel were type-checked and linted but not exercised in a browser; the Tauri folder picker
  compiles and its path rule is unit-tested, but the native dialog was not opened.
- `pick_export_folder` is desktop-only; mobile builds do not register it (the dialog shows the
  text field outside the desktop runtime).
