# Changelog

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
