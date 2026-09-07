# Changelog

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
