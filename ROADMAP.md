# OpenPlod 1.0.0 Roadmap

Updated September 8, 2026. Original baseline: experimental **0.4.1**; latest experimental prerelease: **0.5.0**.

September 8 implementation update: **0.5.0 is an experimental prerelease**, with new speech/text adapters, shared settings, explicit privacy/fallback controls, persisted jobs, per-recording selection, and generated transcript provenance. [Detailed implementation status](docs/ai-providers.md) distinguishes code/tests from live acceptance. Checkboxes remain open until their full release gates are met; spending controls and large-file chunking are not implemented.

**The 1.0 goal:** a dependable local recording vault that can extract from an authorized Plaud Note Pro, transcribe with the AI provider you choose, turn transcripts into useful knowledge, and synchronize with Android without losing audio or edits.

This is a delivery plan, not a list of available features. Unchecked items are planned or partially implemented with acceptance still pending. Milestones describe sequence, not promised release dates. No feature is complete merely because its interface exists or a synthetic test passes.

## Original 0.4.1 Baseline

| Area | Implemented baseline | Still to prove or complete |
| --- | --- | --- |
| Plaud extraction | Direct Mac and SDK-free Android Bluetooth extraction verified on one authorized Note Pro; source retained | Self-service owner authorization, broader firmware coverage, crash/disconnect hardware acceptance |
| Audio library | Durable imports, metadata, tags, playback speed, bookmarks, transcript versions, 30-day Trash | Atomic original-sidecar handling, complete purge, backup/restore, large-library performance |
| Transcription | Mistral Voxtral, local whisper.cpp, Deepgram adapters | Unified capabilities, language/model controls, explicit fallback policy, additional providers |
| Transcript AI | Mistral document generation and recording-context chat; separate OpenAI-compatible summary analyzer | One provider settings model across analysis, documents, and chat |
| Documents | Markdown folders/editor, outline, revisions, exports, reviewed Mistral generation | Backlinks, templates, managed Obsidian export, cross-library knowledge workflows |
| Android | QR vault pairing, encrypted device enrollment, recording/share import, direct extraction on one tested phone | Resumable network upload, background reliability, full physical-phone acceptance, signed distribution |
| Integrations | Authenticated REST APIs, read-only-by-default MCP, configured webhook delivery, OpenWhistle forwarding | Unified job controls, event subscriptions, scoped access, cross-peer reconciliation |

Version 0.4.1 also redesigns Transcripts, AI Chat, and the Android connection page. Its browser checks used two real saved transcripts at 320-1440 px. Mac/Android builds and 16 KB alignment checks passed; this does **not** establish installation, fresh-device compatibility, or runtime behavior on a 16 KB Android device.

See [CHANGELOG.md](CHANGELOG.md) for released history and [README.md](README.md#current-support) for current compatibility. Previous direct-phone evidence comprised two real listed sessions and a 30,208-byte transfer for a 6.86-second recording, with decrypted Opus playback and source retention. That result is specific to the tested enrollment/device combination.

## Product Rules

- Original audio belongs to the desktop vault. Android retains unsynchronized audio until durable storage is acknowledged; processing services own processing results, not the only audio copy.
- Original, AI-generated, translated, and manually edited text remain distinguishable and versioned. Reprocessing never silently replaces a manual edit.
- No mock recordings, invented timestamps, fabricated speakers, or fake AI answers in the product. Unknown device state is not zero recordings.
- Cloud speech-to-text sends audio; transcript analysis sends text. Consent and provider selection must distinguish them.
- Local-only mode forbids cloud fallback, forwarding, remote embeddings, and remote analysis. Missing local capability produces an actionable error.
- Plaud extraction preserves device ownership and source recordings. No reset, force-clear, guessed write commands, or embedded vendor secrets.
- Every milestone preserves existing vaults, API clients, MCP clients, and configured Mistral behavior through tested migrations.

## Delivery Sequence

| Milestone | Main outcome | Dependencies |
| --- | --- | --- |
| **0.5.0** | Multi-provider transcription and shared AI settings | Existing adapters and versioned library |
| **0.6.0** | Transcript Studio: corrections, translation, chapters, reusable AI actions | 0.5 capabilities and processing provenance |
| **0.7.0** | Knowledge workspace: linked documents, richer chat, API/MCP automation | 0.6 version-aware outputs |
| **0.8.0** | Dependable Android capture, direct import, and desktop synchronization | Durable jobs, revisions, and transfer contracts |
| **0.9.0** | Secure beta: validated onboarding, backup, performance, signed packages | All core workflows and hardware evidence |
| **1.0.0** | Stable release with documented support boundaries | Every release gate below |

Plaud onboarding and storage hardening start alongside 0.5, not at the end. Features marked **Stretch** may move after 1.0; audio safety, privacy, and release gates may not.

## 0.5.0 - More AI Providers

### Speech-to-Text

| Provider | Baseline | 1.0 intention |
| --- | --- | --- |
| **Mistral Voxtral** | Integrated | Keep as the recommended cloud option; expose supported model/language controls and harden result validation |
| **whisper.cpp** | Integrated | Local model installation/selection, download integrity checks, resource controls, fully offline acceptance |
| **Deepgram** | Integrated | Expose supported diarization/language features; normalize timestamps and provider errors consistently |
| **OpenAI transcription** | Not integrated | Add a speech-to-text adapter with an explicitly validated model/capability catalog |
| **AssemblyAI** | Not integrated | Add asynchronous transcription jobs, resumable status polling, and supported speaker separation |
| **ElevenLabs Scribe** | Not integrated | **Stretch:** evaluate quality, speaker/timestamp support, retention, limits, and cost before enabling |
| **Other audio-capable providers** | Not integrated | **Stretch:** add only after official API and real-audio validation; do not assume a chat endpoint supports transcription |

Provider/model names are integration targets, not capability or availability guarantees. Pin supported models and verify official API limits when implementing each adapter; do not hardcode speculative prices or limits here.

- [ ] **AI-01:** Separate settings for transcription, transcript analysis, document generation, and chat. Keep existing Mistral configuration during migration.
- [ ] **AI-02:** Add OpenAI speech-to-text with per-job provider/model selection and redacted connection checks.
- [ ] **AI-03:** Add AssemblyAI job submission, polling, cancellation where supported, and restart recovery without resubmitting an uncertain paid job.
- [ ] **AI-04:** Add a capability registry: formats, upload limits, languages, prompts/glossaries, segment/word timestamps, diarization, streaming, and local/cloud execution. Disable unsupported options honestly.
- [ ] **AI-05:** Add automatic language detection and manual language override. Eliminate unintended English-only defaults; retain detected language in provenance.
- [ ] **AI-06:** Add custom vocabulary for names, products, and acronyms where supported. Keep provider hints separate from AI rewriting of transcript text.
- [ ] **AI-07:** Add an explicit per-workflow fallback order and local-only mode. Never send audio to a different cloud provider without prior consent for that fallback.
- [ ] **AI-08:** Add job progress, queue priority, bounded retries, cancellation, and restart-safe processing. Chunk long audio only when necessary; preserve offsets and reconcile overlap without dropping or duplicating speech.
- [ ] **AI-09:** Show provider, model, source fingerprint, options, processing time, and reported usage on every generated version. Label cost estimates and unavailable usage as such.
- [ ] **AI-10:** Add configurable cloud spending limits. Require confirmation for estimated over-budget jobs; do not promise exact spend caps where a provider cannot enforce them.

### AI for Transcript Text

Use a separate analysis adapter contract. A provider supporting text analysis is not automatically a speech-to-text provider.

- [ ] **AI-11:** Unify the existing summary analyzer, Mistral documents, and recording chat under shared provider settings, error handling, and provenance.
- [ ] **AI-12:** Add OpenAI and Anthropic text-analysis adapters for summaries, documents, and cited chat, with independently validated structured-output behavior.
- [ ] **AI-13:** Add local Ollama text analysis. Only expose compatible installed models; warn about hardware/context limits and do not silently switch to cloud.
- [ ] **AI-14:** **Stretch:** add Gemini text analysis and a restricted custom OpenAI-compatible endpoint. Validate capability differences and endpoint security instead of assuming full compatibility.

**Exit gate:** real saved audio is transcribed successfully through each newly supported speech provider using owner-configured credentials; each core analysis adapter completes a real transcript workflow. Contract tests cover malformed/empty results, invalid timestamps, unsupported options, 401/429/5xx, timeouts, cancellation, and redaction. Interrupted jobs do not create duplicate transcript versions or automatic duplicate charges. No provider switch alters source audio or manual edits.

## 0.6.0 - Transcript Studio

- [ ] **TS-01:** Add synchronized audio/text following, word highlighting when genuine word timing exists, and timestamp navigation. Missing timing stays missing.
- [ ] **TS-02:** Expand the existing correction editor with speaker rename/merge, segment split/merge, find/replace, and undo/redo while preserving source timing and revision checks.
- [ ] **TS-03:** Add side-by-side version comparison and explicit promotion of a generated version. Show manual corrections separately from model changes.
- [ ] **TS-04:** Add reviewed AI cleanup: punctuation, paragraphs, optional filler removal, and Markdown headings. Show a diff before saving; retain the verbatim transcript.
- [ ] **TS-05:** Add translation with a target-language selector, linked original/translated views, and separate version history.
- [ ] **TS-06:** Generate timestamp-linked chapters, decisions, action items, and open questions. Keep unknown owners/dates unset rather than inventing them.
- [ ] **TS-07:** Expand document templates: meeting minutes, interview notes, lecture notes, project briefs, PRDs, and follow-up emails. Preview before saving or sending.
- [ ] **TS-08:** Add reusable custom AI actions with instruction templates, selected transcript/version context, preview, and explicit confirmation for writes.
- [ ] **TS-09:** Add SRT/VTT exports when valid timestamps exist, plus structured chapter/action-item exports and readable PDF output. Keep existing Markdown/text/JSON exports compatible.
- [ ] **TS-10:** Add batch transcription and batch document generation with per-item status, cancellation, cost confirmation, and retry-failed-only behavior.
- [ ] **TS-11:** **Stretch:** compare two transcription providers on the same recording with an explicit second-upload/cost confirmation and independent versions.

**Exit gate:** original text survives every cleanup/translation operation; stale saves return conflicts; timestamp edits remain valid; exports match the selected saved version. Real-audio acceptance covers multiple speakers, French and English, silence, background noise, and a long recording. Report quality results and limitations, not a universal accuracy claim.

## 0.7.0 - Knowledge, Chat, and Automation

- [ ] **KB-01:** Add document properties, document tags, recording collections, saved views, and backlinks between documents and exact transcript versions.
- [ ] **KB-02:** Add managed Markdown export to a chosen filesystem/Obsidian folder, with attachments, source links, collision detection, and an export manifest. Start one-way; never overwrite externally edited files silently.
- [ ] **KB-03:** Extend the existing cited chat with conversation rename/archive, project context, pinned sources, follow-up questions, and complete-conversation export.
- [ ] **KB-04:** Add hybrid text/semantic retrieval with local embeddings by default, explicit cloud opt-in, citation previews, and timestamp jumps. Show which recordings were actually used.
- [ ] **KB-05:** Add reviewable AI tag/title suggestions and recurring-topic summaries. Applying suggestions creates ordinary auditable metadata edits.
- [ ] **KB-06:** Add a unified versioned processing-job API for transcription, analysis, progress, cancellation, and history. Use stable IDs and idempotency contracts, preserving existing endpoints.
- [ ] **KB-07:** Extend MCP with source/version inspection and job-status tools. Any processing, modification, or outbound delivery remains opt-in and permission-scoped.
- [ ] **KB-08:** Add signed webhook events for imported/transcribed/document-ready jobs, retry history, delivery IDs, and explicit handling of uncertain delivery.
- [ ] **KB-09:** Add opt-in rules such as "Plaud meeting -> selected transcription provider -> meeting-minutes draft -> Documents/Meetings". Preview the rule's scope, provider use, and cost; external sending requires separate approval.
- [ ] **KB-10:** **Stretch:** reviewed task exports/connectors for Notion, Linear, Todoist, or calendar tools. Local task drafts precede external creation; no automatic posting from transcript instructions.

**Exit gate:** retrieval excludes Trash and removed sources, citations resolve to the exact source versions, and cached embeddings follow delete/purge rules. Treat transcript/document text as untrusted data, never as permission to run MCP tools or send data. Automation has a visible execution history and cannot bypass cloud consent or duplicate downstream writes on retry.

## 0.8.0 - Android and Synchronization

- [ ] **MOB-01:** Finish physical-phone acceptance of QR pairing, encrypted Note Pro enrollment, direct-device import, native recording, share import, playback, transcript editing, and document export.
- [ ] **MOB-02:** Add byte-offset resumable mobile-to-vault uploads with chunk integrity, stable transfer IDs, and a durable final acknowledgement. Current network retries resend the whole file.
- [ ] **MOB-03:** Add a clear offline outbox with pending/failed transfers, manual retry, storage usage, and configurable cache cleanup only after verified desktop storage.
- [ ] **MOB-04:** Complete revision conflicts, queued changes, tombstones, and restore propagation across OpenPlod, OpenNotes, and OpenWhistle. Preserve processing-result ownership.
- [ ] **MOB-05:** Validate direct Plaud recovery after disconnect, process death, screen lock, battery restrictions, and reboot. One client's cancellation must not cancel another client's transfer.
- [ ] **MOB-06:** Add paired-client management, visible last successful synchronization, credential revocation, and per-client permissions. Do not infer live phone presence from a saved pairing.
- [ ] **MOB-07:** Validate foreground-service behavior and a real 16 KB page-size runtime, beyond APK/ELF alignment checks.
- [ ] **MOB-08:** Ship a production-signed SDK-free Android build with an upgrade path that preserves local recordings and enrollment.

**Exit gate:** real interrupted upload and Bluetooth tests resume without missing/duplicate recordings, sources remain on Plaud, offline changes reconcile without overwriting manual edits, and an in-place phone upgrade preserves its outbox. Document the actual tested Android/firmware matrix.

## 0.9.0 - Secure, Recoverable Beta

- [ ] **REL-01:** Deliver owner-authorized fresh-install Plaud onboarding without private developer artifacts. Verify account-free routes only when supported by device evidence; account authorization remains a disclosed fallback, never a cloud-audio dependency.
- [ ] **REL-02:** Validate the device transfer-tail checksum and retain existing authenticated framing, size, and decoded-audio integrity checks.
- [ ] **REL-03:** Make original-device bytes, playable copies, and metadata acknowledgement atomic/recoverable under disk-full, crash, restart, and interrupted import.
- [ ] **REL-04:** Complete 30-day Trash expiry and confirmed purge of audio, sidecars, transcript versions, processing results, search indexes, and embeddings, with peer tombstone propagation.
- [ ] **REL-05:** Add full-vault backup/restore, backup integrity checks, optional encrypted backup archives, and a restore wizard. Document that offline backup archives retain data until separately expired/deleted.
- [ ] **REL-06:** Harden key storage, revocation, pairing transport, file permissions, log redaction, and API/MCP scopes. Add a protected transport for non-loopback credentials/audio; do not market plain-HTTP pairing as secure remote access.
- [ ] **REL-07:** Package or reliably provision runtime dependencies; sign/notarize macOS releases, verify update signatures, and test rollback without downgrading an incompatible vault schema.
- [ ] **REL-08:** Benchmark a 10,000-recording/100,000-segment library on a documented reference Mac. Proposed budgets: p95 list/search under 300 ms and cached detail under 500 ms, excluding provider/network latency. Measure before claiming them achieved.
- [ ] **REL-09:** Complete keyboard/screen-reader checks, touch target and reduced-motion checks, French/English UI localization, and empty/error/loading-state coverage.
- [ ] **REL-10:** Publish installation, migration, recovery, provider privacy/cost, API/MCP, and supported-device documentation. Resolve redistribution/licensing blockers and exclude all private/proprietary test artifacts.

**Exit gate:** a tester other than the original developer installs on a fresh Mac, authorizes their own supported device, extracts and plays audio, restores a backup, and upgrades successfully. Security and compatibility review results are recorded separately from the implementation author's checks.

## 1.0.0 Release Gates

- [ ] All core items above are complete, or formally removed from 1.0 with an explicit scope decision before release. Stretch items do not block release.
- [ ] No known unresolved audio-loss, manual-edit-loss, unauthorized disclosure, or destructive ownership bugs.
- [ ] Fresh-owner Mac onboarding and an independently verified compatibility matrix; unsupported hardware is labeled explicitly.
- [ ] Verified real-audio transcription for every advertised speech provider, and real-transcript generation/chat for every advertised analysis provider.
- [ ] Desktop and Android capture/import -> durable vault -> transcript -> reviewed document -> export acceptance, including interrupted/offline cases.
- [ ] Full-vault migration, backup, restore, Trash, purge, and rollback evidence.
- [ ] Backend tests, type checking, frontend lint/build, UI checks, native builds, Android alignment, and real 16 KB runtime acceptance.
- [ ] Signed release artifacts, checksums, tested upgrades, published support/privacy/licensing boundaries, and a rollback procedure.
- [ ] Release candidate completes at least seven days of documented daily-use testing with no unresolved critical/high-severity defects. Failures restart the affected acceptance checks, not just the build.

## Implementation Boundaries

Extend existing modules instead of creating a second processing stack:

- Provider contracts/adapters: [`src/transcription`](src/transcription), [`src/transcription/router.ts`](src/transcription/router.ts), settings/API configuration in [`src/index.ts`](src/index.ts).
- Durable jobs and transcript versions: [`src/jobs/queue.ts`](src/jobs/queue.ts), [`src/library/processing.ts`](src/library/processing.ts), [`src/library/transcript-history.ts`](src/library/transcript-history.ts).
- Generated documents and cited chat: [`src/organizer/generation.ts`](src/organizer/generation.ts), [`src/organizer/recording-ai.ts`](src/organizer/recording-ai.ts).
- Public contracts: [`docs/api.md`](docs/api.md), [`docs/mcp.md`](docs/mcp.md), their existing route/server modules, and additive migrations.
- Shared desktop/mobile experience: [`web/src/pages`](web/src/pages), with native transport and storage behavior remaining in platform adapters.

Provider implementation tickets must define auth, capability negotiation, input/output schemas, error taxonomy, timeouts, cancellation, retry/idempotency behavior, retention, and live acceptance before enabling the provider. Unknown confidence or unsupported timing is nullable/absent, not invented. Any contract change must preserve old transcript history and existing clients.

## After 1.0

- Live transcription/captions with explicitly supported streaming providers.
- Carefully scoped bidirectional Obsidian sync with conflict resolution.
- Additional Plaud models/firmware only after non-destructive protocol and hardware validation.
- iOS, Windows, and Linux native adapters with independent platform acceptance.
- Local speech diarization, richer on-device AI, and optional end-to-end encrypted multi-device vault replication.
- Team workspaces and collaboration only after a separate authorization/ownership design; no mandatory cloud account for the personal vault.

## First Implementation Batch

1. **AI-01 / AI-04 / AI-07 / AI-11:** define shared settings/capabilities and explicit provider consent/fallback, preserving Mistral and historical versions.
2. **AI-02 / AI-05:** implement OpenAI speech-to-text plus language controls and real-audio acceptance.
3. **AI-03 / AI-08:** add asynchronous AssemblyAI jobs and restart-safe processing before batch work.
4. **AI-12 / AI-13:** extend reviewed documents and cited chat to the core cloud/local analysis adapters.
5. Start **REL-01 / REL-03** in parallel: fresh-owner onboarding and atomic audio retention remain prerequisites for a stable 1.0.

Track feature IDs in implementation issues and release notes. Mark an item complete only with a merged implementation, automated evidence, and any required real-provider/hardware evidence. Roadmap changes alone do not enable a provider, create GitHub issues, or publish a release.
