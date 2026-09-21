# Changelog

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
