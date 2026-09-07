# Changelog

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
