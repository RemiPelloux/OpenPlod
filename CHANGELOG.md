# Changelog

## Unreleased

1.1.0 Sprint 1: performance and housekeeping. See the [sprint plan and outcome](docs/sprint-1.1.0-1.md).

### Changed

- **Faster list endpoints (PERF-01).** Lists no longer run one database query per row. A mobile
  sync page now takes 3 queries instead of up to 1,000. Also batched: task drafts and the `.ics`
  calendar, automation run history, webhook deliveries, batch cost estimates, retrieved chat
  passages, and the Plaud device-recordings list. Responses are unchanged. New query-count
  regression tests keep it that way.
- **Settings save in one request (PERF-04).** New `PATCH /api/settings` takes several legacy
  settings and writes them in one transaction. The Settings page uses it, so a failed save no
  longer leaves some settings changed and others not. `PUT /api/settings/:key` still works.
- **Search no longer waits on a stopped Ollama (PERF-03).** The installed-model check is cached
  for 30 seconds, or 15 seconds when Ollama is unreachable. Before, every search could wait up to
  5 seconds.
- **Dependencies (DEP-01).** Updated within their ranges across the backend, web app and Rust
  crates; `drizzle-orm` 0.45 and `drizzle-kit` 0.31. `eslint-plugin-react-hooks` is pinned at
  7.0.1 until its new React Compiler rules are addressed.

### Fixed

- **Webhook history is bounded (PERF-02).** Finished deliveries older than 90 days are pruned with
  their attempts. Pending deliveries are never pruned. The event id is kept, so a pruned event is
  still not delivered twice.

## 1.0.0 - 2026-10-15

OpenPlod 1.0 implements the whole 1.0 roadmap: every milestone from 0.5 to 0.9, including the
stretch items. It adds a guided first run, transcription profiles, a French interface, and the
0.7.0 knowledge workspace. What still needs real devices, live provider accounts, or signing keys
is listed under [Support boundaries](#support-boundaries) and in the
[roadmap status](ROADMAP.md#100-status).

### Added

- **Transcription profiles.** A profile is a named context prompt plus vocabulary, with an optional
  provider, model, language, and speaker-label choice: "Medical consultation", "Engineering
  standup", "Réunion (français)", and five other presets to start from, or your own. Choose a
  default in Settings > AI providers, or pick one per recording in the Transcribe dialog, where you
  can also add a one-off context for that recording. Profiles are hints sent with the audio; they
  never rewrite a transcript.
  - **Prompts reach the models that take them:** OpenAI (`whisper-1`, `gpt-4o-transcribe`,
    `gpt-4o-mini-transcribe`) receives the prompt and vocabulary; whisper.cpp receives them as its
    `--prompt`; Deepgram now receives vocabulary as `keywords` (Nova-2) or `keyterm` (Nova-3, newly
    selectable); AssemblyAI keeps `word_boost`. Mistral Voxtral takes neither.
  - **No silent drops.** A profile written for any provider leaves out the hints the chosen provider
    cannot take, and the transcript's provenance lists them (`ignoredProfileHints`). A prompt or
    vocabulary set directly on a job for a provider that cannot take it is still refused with `400`.
    The settings and dialogs show what will be ignored before anything runs.
  - New endpoints: `/api/v1/transcription-profiles` (CRUD and presets). New AI settings fields:
    `transcriptionPrompt` and `transcriptionProfile`. New capability flag: `prompt`.
- **First-run setup guide.** Five steps: welcome, local-only or chosen providers, a transcription
  model with its key and a connection check, a profile preset, and where to bring recordings in
  from (Plaud, files, microphone, Android, or documents). It is skippable, works at phone width, and
  can be run again from Settings or the command palette. New endpoints: `GET /api/onboarding`,
  `POST /api/onboarding/complete`, `POST /api/onboarding/reset`.
- **Command palette.** ⌘K / Ctrl+K now lists quick actions (go to any workspace, import, record,
  Plaud, Android, transcription profiles, API and MCP, run the setup guide) alongside search
  results, with arrow-key navigation.
- **KB-05 AI title and tag suggestions** for documents. "Suggest" in a note's tag row asks the
  summaries provider for a title and up to five new tags; each one is applied only when you click
  it, as an ordinary revision-checked edit. Long notes send their first 24,000 characters and say
  so. New endpoint: `POST /api/v1/documents/:id/suggestions`.
- **MCP:** read-only `list_transcription_profiles`.

### Added: AI providers (0.5.0 items)

- **Spending limits (AI-10).** A monthly budget and a per-job threshold. Prices come from a dated
  table, always labelled as estimates; a price that isn't known stays unknown rather than guessed.
  Every transcription and batch shows the estimate. A job over the threshold or the remaining
  budget needs explicit confirmation (`409 cost_confirmation_required`), and a ledger records each
  job's estimate and the usage the provider reported.
- **Long audio (AI-08).** Files over a provider's size limit, or longer than a duration you choose,
  are split with ffmpeg into overlapping 10-minute chunks. Their timestamps are offset to the full
  recording and the overlap is merged without dropping or repeating speech. Each chunk is
  checkpointed, so a restart resumes after the last finished chunk. Jobs now report progress, and
  safe failures (nothing outstanding at the provider) retry at most twice.
- **More providers (AI-14).** Gemini, and a restricted OpenAI-compatible endpoint: HTTPS only
  (except loopback), no redirects, and treated as cloud unless it is local.
- **Per-task fallback (AI-07).** Summaries, documents and chat each have an explicit ordered
  fallback list. Local-only mode is enforced at every step, and the provider that actually answered
  is recorded.
- **Other provider work:**
  - AssemblyAI: remote cancel (AI-03).
  - Capability catalogs: languages and timestamp granularity per model (AI-04/05).
  - Provenance for summaries and documents (AI-09).
  - Shared provider settings for chat and documents (AI-11).
  - Ollama context-window checks, so a long transcript is refused instead of cut short (AI-13).

### Added: Transcript Studio (0.6.0 items)

- **Saved structure (TS-06).** Chapters, decisions, action items and open questions are saved per
  transcript version, with history. Every timestamp comes from your own segments.
- **PDF export (TS-09)**, generated on the server, for transcripts and structure, alongside
  SRT/VTT, Markdown, CSV, JSON and HTML.
- **Batch documents (TS-10).** Create documents for many transcripts at once, with per-item status,
  cancel and retry-failed-only. Before it starts, the batch confirms the scope and which provider
  receives the text.
- **Provider comparison (TS-11).** Transcribe the same recording with a second provider, after
  confirming that the audio is sent again. The result is an independent version, compared side by
  side.

### Added: knowledge and automation (0.7.0 items)

- **Recording collections (KB-01)**, with a sidebar group, "Add to collection", a list filter and
  MCP tools.
- **Export (KB-02).** Markdown export can copy attachments (source audio and the cited transcript
  version) under the same conflict rules. The export folder can be chosen in the app, with a native
  picker on desktop.
- **Chat (KB-03).** Pin recordings to a conversation, add a project-context note, and get up to
  three suggested follow-up questions, which are never sent automatically.
- **Hybrid search (KB-04)** over transcript passages and notes. It uses local Ollama embeddings
  when they are installed, a built-in offline lexical index otherwise, and cloud embeddings only
  after an explicit opt-in. Cached passages follow Trash, purge and new transcript versions. Chat
  can answer across the whole vault and shows which recordings it actually used.
- **Suggestions and topics (KB-05).** Reviewable title and tag suggestions for recordings, and
  recurring-topic summaries that you can save as documents.
- **Jobs (KB-06).** `POST /api/v1/jobs` and an `Idempotency-Key` header on reprocessing; analysis
  runs through the job queue.
- **MCP scopes (KB-07).** `OPENPLOD_MCP_SCOPES` (`read`, `write:documents`, `write:folders`,
  `process`, `deliver`), plus `start_transcription` with explicit cloud consent, `search`, and
  collection tools.
- **Signed webhooks (KB-08)** for imported, transcribed, document-created and failed-job events:
  HMAC-SHA256 signatures, stable event and delivery IDs, retries with full history, an `unknown`
  outcome for uncertain sends, and manual redelivery.
- **Opt-in automation rules (KB-09)**, for example "Plaud meeting → transcribe with a profile →
  meeting minutes in a folder → tag → collection → webhook". Each rule has a preview, explicit
  approval for cloud and outside hosts, a per-step history, and idempotent retries.
- **Reviewed task exports (KB-10).** Action items become local drafts that you edit and approve,
  then export to Todoist, Linear, Notion or an `.ics` calendar file. Nothing is posted
  automatically.

### Added: Android and sync (0.8.0 items)

- **Paired devices (MOB-06).** Each phone gets its own credential (only a hash is stored), with
  last-seen and last-sync times, rename, revoke and rotate. The page never shows "online" based on
  a saved pairing.
- **Resumable uploads (MOB-02).** Phone uploads resume from the last confirmed byte. Each chunk is
  checked with SHA-256, a transfer keeps the same ID across retries, and the whole file is verified
  before the desktop acknowledges it. The web and Android clients both use this.
- **Offline outbox (MOB-03)** listing pending and failed recordings, retry counts, storage used,
  manual retry, and cleanup only after the desktop has verified its copy.
- **Sync change feed (MOB-04)** with tombstones for Trash, restore and purge. Metadata edits are
  pushed with a revision check: a stale edit comes back as a conflict and nothing is overwritten.
- **Android release signing (MOB-08)** from your own keystore, plus a documented upgrade-in-place
  path. Transfers are scoped to the client that created them (MOB-05).

### Added: secure, recoverable vault (0.9.0 items)

- **Crash-safe import (REL-03).** Originals and playable copies are written to staging, synced to
  disk and renamed into place before the database commit, tracked by an import journal. Startup
  recovers interrupted imports; free disk space is checked first.
- **Complete purge (REL-04).** Sidecars, resume files, job payloads, search passages and import
  events are removed too. AI answers that quoted the recording are redacted, and the purge is
  recorded for sync.
- **Backup and restore (REL-05).** Full-vault archives with a SHA-256 manifest and optional
  AES-256-GCM encryption, a verify step, and a restore wizard in Settings that never overwrites a
  vault without asking.
- **Hardening (REL-06).** API keys, connector tokens and webhook secrets are encrypted at rest. The
  request logger redacts secrets, file permissions are tightened, and optional TLS is available for
  the vault server.
- **Packaging (REL-07):**
  - An auto-updater with a "Check for updates" control in Settings.
  - A release workflow that builds macOS, Linux and Windows bundles with `SHA256SUMS`, signing
    them when your keys are configured.
  - A guard that refuses to open a vault created by a newer version.
- **Benchmark (REL-08):** `bun run bench` on a 10,000-recording, 100,000-segment synthetic vault.
- **Accessibility and languages (REL-09).**
  - The interface is available in **French and English**: it follows the system language, and you
    can change it in Settings or at first launch.
  - `bun run check:a11y` runs an automated axe and keyboard-focus check. The issues it found are
    fixed, and every page now passes at desktop and phone width.
- **Transfer checksum (REL-02).** All CRC-16 variants of the device's transfer-tail checksum are
  computed and recorded. A transfer is never rejected on an unconfirmed algorithm.
- **New guides:** backup and restore, upgrade and migration, recovery, supported devices, provider
  privacy and cost, automation, and mobile sync.

### Fixed

- Deepgram speaker labels were requested with an undocumented parameter (`diarize_model`); the
  adapter now sends `diarize=true`.

### Knowledge workspace: 0.7.0 Sprint 2

Keeping knowledge: saved views, a managed folder export, and conversation management
([sprint plan and outcome](docs/sprint-0.7.0-2.md)).

#### Added

- **KB-01** saved document views. Save any combination of folder, Starred or Trash, search, tag,
  and sort under a name; views list matching notes live and appear in the Documents sidebar.
  New endpoints: `/api/v1/views` and `/api/v1/views/:id`.
- **KB-02** managed one-way Markdown export to the folder named by `OPENPLOD_EXPORT_DIR`, such as
  an Obsidian vault. Notes keep their folder tree and gain YAML front matter with their id, tags,
  properties, and source transcript version. A manifest records what OpenPlod wrote; files edited,
  deleted, or created elsewhere are reported as conflicts and never overwritten unless you tick
  them. Every export can be previewed first. New endpoint: `/api/v1/exports/markdown`, and an
  "Export to folder" button in Documents.
- **KB-03** chat conversations can be renamed, archived and restored, and exported whole as
  Markdown or JSON, with each quote resolved to its recording, timestamp, and transcript version.
  A follow-up question returns an archived conversation to the main list.
- **KB-07** read-only MCP tools `list_saved_views` and `get_markdown_export_status`.

### Knowledge workspace: 0.7.0 Sprint 1

Knowledge links and a shared job API ([sprint plan and outcome](docs/sprint-0.7.0.md)), plus fixes
from a correctness and performance audit.

#### Added

- **KB-01** document tags and schemaless properties. Tags are freeform and case-insensitive; a tag
  chip row filters Documents, and the filter composes with folders, views, and search. Properties
  keep their JSON types and merge by key on update. Migration is additive.
- **KB-01** resolved sources and backlinks. A note reports whether the transcript version it was
  written from is still current, has been superseded (`stale`), or can no longer be found
  (`unknown`), and lists other notes written from the same version. New endpoints:
  `/api/v1/documents/:id/source`, `/api/v1/tags`, `/api/v1/recordings/:id/transcript-versions`,
  `/api/v1/transcript-versions/:id`, and `/api/v1/transcript-versions/:id/backlinks`.
- **KB-06** versioned processing-job API: `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, and
  `POST /api/v1/jobs/:id/cancel`, with `startedAt` and produced transcript version ids.
  `/api/jobs` keeps its shape.
- **KB-07** read-only MCP tools: `list_tags`, `get_document_source`, `list_transcript_versions`,
  `get_transcript_version`, `list_transcript_backlinks`, `list_jobs`, and `get_job`.

#### Fixed

- Batch transcription offered, and queued, every recording in the library, including ones already
  transcribed, which could pay for a second transcription. The library list now reports
  `hasTranscript`, and the batch endpoints skip transcribed recordings.
- A batch reported items complete without transcribing them when automatic transcription was off
  or forwarding was on. Batches now queue transcription directly.
- Recordings imported over Bluetooth were never transcribed, even with "Transcribe after import" on.
- After a crash, a recording whose transcription was interrupted showed "transcribing" forever; it
  now shows the failure.
- A configured fallback transcription provider that lacked a requested option (speaker labels,
  vocabulary) aborted the whole job instead of being skipped with a reason.
- Reprocessing while a job was already running reset the recording to `pending` and silently
  dropped the new options; it now answers `409`.
- Replacing a recording's audio left it `pending` with the old audio's transcript; it now
  processes the new audio like an import, and audio in Trash cannot be replaced.
- Transcript Studio speaker rename, merge, and per-speaker find/replace failed for diarized
  speakers, and correcting one segment rewrote every speaker label and dropped word timings.
- Find/replace treated `$&`, `$1`, and `$$` in the replacement as patterns instead of literal text.
- Subtitle export lost speaker labels after a speaker was renamed.
- Global search returned recordings in Trash, and its excerpts missed matches when the query's
  words were not adjacent.
- Full folder syncs ignored the recording-type filter and re-hashed every file on each sync.
- Two concurrent imports of the same file could create duplicate recordings.
- Edits on the recording page were overwritten every few seconds while it was processing, and
  switching recordings quickly could show the previous one.
- Document-generation progress events always named Mistral as the provider.
- Trash retention now also runs every six hours, not only at startup.

#### Performance

- Finished processing jobs are pruned after 30 days (at most 1,000 kept) instead of accumulating in
  memory and the database forever.
- Playback no longer re-renders the whole transcript on every animation frame in the library
  preview, or re-parses the Markdown transcript several times a second on the recording page.
- A pending recording's page polls every 15 seconds instead of every 2.5, and polls no longer
  download every transcript version's full text.
- New index for library lists, and an index for document backlinks.

#### Removed

- Unused code: the transcription barrel module and its Groq engine, the never-written speaker
  profile lookup on recording detail (the always-empty `transcript.speakerLabels` field),
  `saveTranscriptVersion`, `identityFileExists`, `TranscriptionRouter.getEngine`, the unrouted
  Search page, the unused `api.sync` and `notesApi.snapshot` clients, and a duplicate transcript
  version client.
- Tests now run against a throwaway database instead of `./data`, and the Bluetooth environment
  tests no longer depend on a locally built bridge.

### Validation

- All 594 tests in the root `bun test` run pass, including the 52 frontend tests, along with
  type checking, frontend lint and the production build. `cargo check` passes for the desktop app with the updater plugin.
- A test fails if any interface string lacks a French translation or a French entry drops a
  placeholder.
- `bun run check:a11y` passes on 13 routes at 1440 px and on a phone viewport with reduced motion.
- A browser sweep of every route in French and English, at 1440 px and 390 px, against a seeded
  vault, showed no console errors and no sideways scrolling.
- Benchmark on a Linux laptop (not the reference Mac):

  | Operation | p95 |
  | --- | --- |
  | List | 7.7 ms |
  | Search | 46 ms |
  | Detail | 0.4 ms |

### Support boundaries

- **Live providers.** No live provider was called for this release. Every provider, connector and
  embedding path is tested against recorded request shapes and injected responses. The prices in
  the spending table are estimates dated in the code.
- **Hardware.** Plaud hardware evidence is unchanged: one authorized Note Pro on macOS and Android,
  and discovery on Linux.
- **Android.** The Android changes (resumable upload, outbox state, checksum, signing) have not
  been compiled on this machine or run on a phone.
- **Transfer checksum.** Enforcement waits for one real capture to identify the algorithm.
- **Signing.** Release signing, notarization and updater signatures need your keys. The release
  workflow has not run on GitHub yet.
- **Not translated:** server error messages and AI-generated text stay in the language they were
  produced in.

## 0.6.0 - 2026-09-21

Transcript Studio. Editing, version comparison, reviewed AI operations, structured exports, reusable
actions and batch transcription, reachable from a new Studio mode on the recording page.

### Added

- **TS-01** playback following. The transcript scrolls with the audio and holds its anchor through a
  pause instead of jumping to the top. Word-level highlighting renders only when a provider genuinely
  returned per-word timings; Deepgram's word timings are now persisted rather than discarded, and a
  transcript without them says so and follows by segment.
- **TS-02** editing operations: speaker rename/merge, segment split/merge, and literal find/replace
  with match-case, whole-word and per-speaker scoping. A preview shows the result before anything is
  written. Undo restores the previous version, so it survives a reload and leaves the undone version
  in history.
- **TS-03** version comparison and promotion. A word-level diff labels each change as
  `manual-correction`, `regeneration`, `manual-revision` or `reverted-to-generated`. Promotion is the
  only way a stored version becomes current, and the replaced version stays in history.
- **TS-04** reviewed AI cleanup: punctuation, paragraphs, optional filler removal and headings, shown
  as a diff and saved only on an explicit accept.
- **TS-05** translation, stored as its own version lineage and never promoted over the original.
- **TS-06** extraction of chapters, decisions, action items and open questions.
- **TS-07** document templates, three to seven: structured notes, meeting minutes, interview notes,
  lecture notes, project brief, product requirements and follow-up email.
- **TS-08** reusable custom AI actions: a saved instruction re-runnable against any transcript,
  previewed and never written automatically.
- **TS-09** subtitle export (SRT/VTT) and structured exports (Markdown, chapters, CSV, JSON,
  print-ready HTML).
- **TS-10** batch transcription with per-item status, cancellation, confirmation before running, and
  retry-failed-only.
- `bun run check:studio`, a read-only Playwright acceptance for the studio.

### What this release refuses to do

These are the design decisions behind most of the code above, and they are the reason several
outputs are smaller than a model would happily produce:

- **Models never emit timestamps.** For TS-06 the model is shown numbered segments and must cite an
  index; every time is then read from our own segments. An index it invents resolves to no link
  rather than a plausible-looking time.
- **Unknown stays unknown.** An unstated owner or due date stays null — including when a model writes
  "unknown" or "TBD" — renders as an em dash, and exports to CSV as an empty field. A spoken
  "next Friday" is kept verbatim, never resolved to a date.
- **Timing is never invented.** Splitting a segment interpolates a boundary only inside that
  segment's own real span, and an untimed segment stays untimed. Subtitles are refused, with the
  reason, for a transcript whose provider returned no timing — including the common all-zero
  placeholder. Word highlighting is never interpolated from a segment span.
- **Nothing is saved on a first click.** Cleanup, translation and custom actions return proposals.
  Both save paths require the source hash that was reviewed and return 409 if the transcript moved.
  Cleanup is rejected outright if it drops more than half the transcript's content words.
- **Batches confirm before spending** and report scope and provider rather than a currency figure,
  because providers price per second of audio or per token and OpenPlod does not know either before
  the call. Retrying re-submits only failed items, never a succeeded one.
- **Transcripts are data, not instructions**, in every prompt added here.

### Changed

- The recording page gains a fourth mode, Studio, beside Markdown, Edit and Transcript.
- `TranscriptSegment` may now carry `words`. Absent remains meaningful: it means no word timing
  exists, not that it is zero.

### Validation

360 automated tests pass (1,614 assertions); 6 pre-existing failures remain, unrelated to this work
and reproducing at 0.5.0 (`UNIQUE constraint failed: transcripts.recording_id`, only when the full
suite shares one database). Backend type checking, frontend lint and frontend build pass.

`bun run check:studio` passes against a real vault: five tabs render, find/replace Apply stays
disabled until a preview reports matches, the custom-action form stays disabled until complete, four
real versions list, the subtitle refusal renders its reason, batch requires confirmation before
running, no horizontal overflow at 1440/1180/900/390/320px, production CSP applied, zero page errors,
and no request that would mutate a vault or call a provider.

### Not claimed

**The 0.6.0 exit gate has not been run.** It requires real-audio acceptance across multiple speakers,
French and English, silence, background noise and a long recording. That needs audio and provider
credentials this build was not tested with, so no roadmap item that depends on a live provider is
marked complete.

Specifically: no AI path — cleanup, translation, extraction, custom actions, document templates — has
been exercised against a real provider; every one is covered by stubbed contract tests only. Word
highlighting is unit-tested against fixtures but was never rendered against a transcript that
actually carries word timings, because none exists in the test vault. Extracted structure is
returned and exportable but not persisted. TS-09's PDF path is browser print rather than a generated
file; no PDF engine was added. Plaud device compatibility is unchanged from 0.5.1.

## 0.5.1 - 2026-09-21

Cross-platform Bluetooth patch: one bridge for every desktop, plus host autodetection. This is a
platform patch on 0.5.0, not a roadmap milestone; 0.6.0 remains Transcript Studio.

### Added

- `plaud-bridge doctor`, a non-scanning host check reporting the Bluetooth backend, adapter name, and power state. It exits 0 even with no adapter so callers render a diagnosis instead of an error.
- Host autodetection (`src/sync/plaud-environment.ts`) that checks the platform, bridge, adapter power, `ffmpeg`/`ffprobe`, and recorder authorization independently, each with a platform-specific remediation.
- `GET /api/plaud/environment` returning that report, with `?refresh=1` to bypass the 15-second coalescing cache. `GET /api/plaud/status` now also carries `platform`, `bluetoothBackend`, `bluetoothReady`, and `environmentBlockers`.
- A **This computer** panel on the Plaud page showing every check and its fix.
- `bun run doctor` (with `--json`), `bun run device:doctor`, and `bun run build:bridge`.
- A CI job that builds and clippy-lints the bridge on Linux, macOS, and Windows, and asserts `doctor` reports a backend on a runner with no adapter.
- `.deb` and `.rpm` dependency declarations for BlueZ, D-Bus, and ffmpeg.

### Changed

- The Rust `plaud-bridge` is now the default Bluetooth helper on **every** desktop platform, including macOS. One code path is exercised everywhere instead of Swift on macOS and Rust elsewhere.
- The macOS Swift helpers are now an opt-in fallback only, selected with `OPENPLOD_BLE_BACKEND=swift`. They are never chosen automatically, and Linux and Windows can never be steered onto a backend they cannot run.
- The Tauri host sets `OPENPLOD_BLE_BRIDGE` on all desktop platforms; the Swift resource paths are exported on macOS only.
- Status no longer scans the air when the host itself cannot do Bluetooth; it reports the blocking condition instead.

### Fixed

- The scan probe gave connect-and-discover a 10-second budget while the transfer path allowed 35. With a cold BlueZ cache the first scan after boot reported a healthy, connectable recorder as "Bluetooth connection failed". The probe now gets the same budget; reproduced against real hardware and re-verified.
- Removed an unused `useCallback` import that failed `web` lint.

### Validation

Ran on Arch Linux (kernel 7.2.3) against an authorized Plaud Note Pro, serial `8810B50327175322`, protocol 20: `plaud-bridge scan` reported `connectionVerified: true`, and `plaud-bridge connect` reached `ready` with the `0x1910` command service and both characteristics discovered. `GET /api/plaud/environment` and `GET /api/plaud/status` were verified against a running service.

Automated: 18 new tests for backend selection, the host check parser, audio-tool detection, and the environment report; `cargo clippy -D warnings` clean; backend type checking, frontend lint, and frontend build pass.

**Not claimed:** no end-to-end Linux audio download — that needs a provisioned recorder identity, which the test machine does not have. No macOS or Windows runtime acceptance of the new default backend; both compile and are covered by CI, but neither was run against hardware in this cycle. Plaud device compatibility is unchanged. Six pre-existing test failures (`UNIQUE constraint failed: transcripts.recording_id`, only when the full suite shares one database) remain open and are unrelated to this release; they reproduce at 0.5.0. No roadmap item is marked complete by this patch and no 1.0 release gate is claimed.

## 0.5.0 - 2026-09-08

Experimental multi-provider prerelease; not a completed roadmap milestone.

- Add OpenAI speech-to-text and AssemblyAI asynchronous transcription with persisted remote IDs and bounded status retries.
- Share Mistral, OpenAI, Anthropic, and local Ollama adapters across summaries, Markdown documents, and cited chat.
- Add separate provider/model settings, automatic language detection, supported vocabulary hints, per-recording transcription confirmation, and explicit fallback selection.
- Enforce local-only processing and block OpenWhistle forwarding in that mode. No automatic model download or cloud fallback for local Whisper.
- Persist processing jobs, cancellation, priority API, safe polling resume, fingerprint checks, and idempotent generated versions. Preserve manually edited transcripts.
- Store generated transcript provider/model/options/fingerprint/timing/reported usage. Missing confidence, speakers, and usage stay unknown.
- Replace the summary analyzer's silent truncation and permissive JSON parsing with bounded input, validated output, and source-version checks.
- Keep existing Mistral credentials and document provenance through additive migrations. Legacy summary-only `LLM_*` configuration requires explicit migration in AI settings.

Live acceptance for the newly added providers, spending controls, automatic large-file chunking, complete capability catalogs, and Android runtime acceptance remain open. Plaud compatibility is unchanged: only the documented Note Pro setup has hardware evidence. See [implementation status](docs/ai-providers.md).

Validation: 122 Bun tests (1,076 assertions), backend type checking, frontend lint/build, macOS production build, and Android ARM64 debug build with 16 KB ZIP/ELF alignment checks passed. Real-vault browser checks covered playback, exports, transcripts/chat, settings persistence, consent, and responsive layouts. No new native-runtime, live-provider, or Plaud hardware acceptance is claimed.

Distribution: macOS Apple Silicon ZIP and SHA-256 checksums. The Mac app is ad-hoc signed, not notarized; external extraction tools and existing Plaud authorization remain required. The Android debug APK is not published. Back up the entire vault before upgrading; replace only the app bundle.

## 0.4.1 - 2026-09-07

Experimental prerelease: transcript, AI Chat, and Android connection workspaces.

### Added

- Dedicated Android connection page with private, reveal-on-demand pairing QR, automatic QR hiding, vault reachability checks, and confirmed desktop unpairing.
- A staged 1.0.0 roadmap covering additional transcription/analysis providers, Transcript Studio, knowledge organization, synchronization, and release safety gates. These are planned features, not new provider integrations in this release.
- Real-vault UI regression checks for the transcript reader, exports, Mistral document dialog, chat consent/context, Android connection states, and mobile Back navigation.

### Improved

- Transcripts now use a compact list-and-reader workspace with Markdown preview/source modes, Markdown/text/JSON exports, source filtering, editing links, and Mistral document creation.
- AI Chat now has a collapsible sources/history panel, selected-source chips, prompt shortcuts, answer copy/export controls, and a fixed composer with explicit cloud consent.
- Shared custom SVG controls, light/dark styling, and responsive layouts match the existing recording/document workspace.
- Transcript navigation follows browser Back on small screens. Stale asynchronous responses cannot replace a newly selected transcript or conversation.
- Settings retains its old pairing link but routes to the dedicated Android workspace; clipboard failures are handled and private pairing codes are masked.

### Validation

- 106 Bun tests; backend type checking; frontend lint; production macOS build.
- Read-only real-vault UI checks at 320, 390, 900, 1180, and 1440 px, including exports and failure recovery under the production content-security policy.
- Existing recording UI regression suite covers real playback, waveform pixels, tooltips, tags, search, and keyboard navigation.
- Android ARM64 debug build and 16 KB APK/ELF alignment checks; physical-phone installation and 16 KB runtime acceptance are not claimed.

### Known Limitations

- Mac package is ad-hoc signed, not notarized. External extraction dependencies and privately provisioned initial Plaud authorization remain required.
- Only the Mac package is published; the Android debug APK remains a local development artifact, not a production-signed release.
- No new live-provider or Plaud hardware extraction acceptance in this UI release. Historical extraction evidence and 0.4.0 device/firmware limitations still apply.
- Additional AI providers in the 1.0 roadmap are not enabled by this release.

## 0.4.0 - 2026-09-07

Experimental prerelease: desktop workspace and direct-device improvements.

### Added

- Recording-context AI chat through Mistral, with selected sources, consent, stored conversations, citations, and Markdown export.
- Timestamp bookmarks, playback speed controls, segment/speaker editing, and right-click recording tags.
- Native Android direct Bluetooth adapter without the proprietary Plaud SDK, plus encrypted enrollment approved on an authorized Mac.
- Opt-in automatic Plaud import and offset-based Bluetooth transfer checkpoints.
- 91 custom SVG icon exports, visible build identity, and a verified Mac installer with recoverable duplicate-app archives.
- MIT license for original OpenPlod contributions, licensing-scope documentation, and GitHub Sponsors integration.

### Improved

- Consistent compact Recordings, Documents, and Plaud Device workspaces in light and dark themes.
- Markdown selection formatting, document outline/source panels, export controls, and small-screen layouts.
- Audio loading now times out, supports cancellation, and reports decoding failures instead of leaving playback spinning.
- Installer launch environment avoids inherited terminal XPC settings that can leave a native window blank.

### Validation

- 106 Bun tests, backend type checking, frontend lint, and production Mac build.
- Android ARM64 debug build and 16 KB APK/ELF alignment checks passed; no new physical-phone acceptance or APK publication in this release.
- Real-library browser checks for playback, waveform rendering, export, document formatting, tooltips, navigation, and responsive layouts at 320-1672 px.
- Installed Mac interface and retained recordings verified separately from browser tests.
- Prior hardware acceptance: direct extraction and source retention on one authorized Note Pro, on Mac and Android. Hardware compatibility was not re-established across other devices for this release.

### Known Limitations

- Initial desktop identity provisioning is not self-service or verified account-free. Android enrollment requires the already-authorized Mac.
- Mac download is ad-hoc signed, not notarized; direct extraction requires external Swift, ffmpeg, and ffprobe.
- Android source is experimental. This release distributes a Mac ZIP, not a production-signed Android APK.
- Byte-offset mobile-to-vault upload resumption, cross-peer tombstone propagation, original-sidecar purge, and broad device/firmware acceptance remain open.
- Upstream declares MIT in its README but supplies no standalone license notice; see LICENSING.md.

## 0.3.0 - 2026-09-07

Experimental desktop-first release.

### Added

- Markdown document workspace with nested folders, search, stars, revision history, Trash, exports, and configured webhook delivery.
- Mistral-powered structured notes, meeting minutes, and briefs from transcripts, with streamed progress and review before saving.
- Versioned organizer REST API and read-only-by-default stdio MCP server, with explicit write opt-in.
- Original OpenPlod vector logo, platform icons, repository support links, contribution/security guidance, and CI.

### Improved

- Compact shadcn/Radix workspace, neutral light/dark themes, clearer Recordings/Transcripts/Documents navigation, and responsive layouts.
- Recording sorting, accessible layout/filter controls, separate Trash actions, and protection against stale library responses.
- Real audio timeline with keyboard seeking, replacing the illustrative waveform.
- Documentation distinguishes proven device extraction from authorization, fresh-install, and Android limitations.

### Validation

- 76 Bun tests; backend type checking; frontend lint and production build.
- Mac build and installed Android update; Android APK and six ARM64 libraries pass 16 KB alignment checks.
- Real-vault browser checks at 320, 390, 768, 1024, and 1440 px, including playback, keyboard seeking, document modes, import/generation dialogs, and export menus.

### Known Limitations

- Direct extraction is verified on one pre-authorized Note Pro and Apple Silicon Mac, not a general device compatibility guarantee.
- No self-service desktop device-identity provisioning yet. Initial account-free authorization is not verified.
- Mac distribution is not notarized and requires external ffmpeg/ffprobe and Swift tooling for direct extraction.
- Public Android APK redistribution is withheld because the bundled Plaud SDK binary has separate proprietary terms.
- Complete on-phone workflows, interrupted transfer recovery, original-sidecar purge, and cross-peer tombstones remain open.

## 0.2.0 - 2026-09-05

- Direct authorized Note Pro extraction on macOS, durable recording vault, transcript versions, shared Plaud import UI, Mistral transcription, and experimental Android companion.
