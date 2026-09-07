# OpenPlod Roadmap

Updated September 7, 2026 for the 0.3.0 experimental release. Desktop remains the primary audio owner; Android is an experimental companion. A build or simulated response is not a hardware acceptance result.

## Current Development Changes (Unreleased)

- Native SDK-free Android Bluetooth extraction: two real Note Pro sessions listed, 30,208 device bytes downloaded for a 6.86-second recording, decrypted Opus playback advanced, source retained.
- One-time encrypted phone enrollment from an already-authorized Mac, with a short verification code and Android Keystore storage. Fresh-owner authorization is still a separate gate.
- Opt-in desktop/Android automatic imports; source-ID deduplication, bounded reconnect retries, and offset-based Bluetooth recovery. Desktop checkpoints append only new bytes rather than rewriting the growing prefix.
- Recording bookmarks, playback speed, timestamp-preserving transcript corrections and speaker labels.
- Mistral recording-context AI tab with selected sources, explicit provider consent, persisted conversations, quote-checked citations, activity stages, and Markdown export. Live Mistral acceptance passed on a real saved transcript.
- 89 passing Bun tests; Android protocol tests cover the independent CryptoKit fixture, tampering/replay, command allowlist, and list pagination. Device evidence remains separate from synthetic tests.

Remaining reliability gates: forced disconnect/process death during a real transfer, unattended Android foreground-service recovery under battery restrictions, fresh-device provisioning, and a true 16 KB runtime device. Mobile-to-desktop network uploads still retry the whole file.

## Delivered in 0.3.0

- Markdown organizer, Mistral-generated documents with review-before-save, authenticated REST API, and opt-in-write MCP server.
- Compact shared desktop/mobile workspace with shadcn/Radix controls, real audio timeline, sorting, and neutral light/dark themes.
- Original vector branding, release documentation, contribution/security templates, and continuous integration.
- 76 passing source tests plus real-vault browser checks from 320 to 1440 px, including playback and keyboard seeking.
- Redesigned Android development update installed in place and launched on a Samsung phone; six ARM64 libraries pass 16 KB alignment checks.

The public release excludes the SDK-containing Android APK because upstream explicitly reserves separate proprietary binary terms. Fresh-install authorization and complete physical-phone workflows remain open gates.

## Delivered in 0.2.0

- Direct Mac-to-Note-Pro Bluetooth session, authenticated listing, offset-based download, decoding, and durable library import.
- One real recording downloaded, played, and checked for source retention on an authorized Note Pro. Account authorization supplied keys; no cloud audio download or phone audio relay was used.
- Preserved encrypted device original, decoded Ogg audio, playback copy, SHA-256, and source provenance.
- Shared Get from Plaud dialog in Library and New Recording: selection, New/Saved filtering, sorting, sequential imports, cancellation, retry, Trash restore, and open-recording links.
- Markdown transcript library, manual/generated version history, document exports, metadata editing, audio playback, and Trash controls.
- Mistral transcription adapter, optional local/Deepgram processing, and OpenWhistle forwarding.
- Updated Mac and Android 0.2.0 builds. Mobile's shared import dialog uses the paired Mac's Bluetooth adapter.

Validation: 50 Bun tests; TypeScript and frontend lint/build; macOS and Android builds; APK ZIP and ARM64 library 16 KB alignment; responsive browser-fixture checks at three viewport sizes. Existing native document export and synthetic-speech Mistral checks passed earlier in development. Final installed-phone touch-flow acceptance is incomplete.

## Notes and Automation

The current source also includes a Markdown organizer, versioned note/folder API, and optional stdio MCP server. Folder CRUD, note snapshots/history/Trash, idempotent delivery, and read-only MCP defaults have automated coverage. Browser acceptance uses an isolated test vault; configured real third-party delivery remains a separate integration check. See [API](docs/api.md) and [MCP](docs/mcp.md) documentation.

Mistral document generation has live acceptance against a real Plaud transcript: structured Markdown, review before saving, source preservation, provider provenance, and a persisted processing trace. The shared Android redesign update is installed and starts successfully; complete on-phone Mistral workflow validation remains open.

## Next: Reproducible Desktop Authorization

- Add supported, owner-authorized onboarding for the existing binding credential and signed device identity.
- Keep credentials in protected local storage with explicit rotation and revocation behavior.
- Preserve device ownership; never offer force-clear, reset, or rebinding as a workaround.
- Validate fresh install without local developer artifacts, missing dependencies, permissions, expired credentials, and firmware differences.

Exit gate: another authorized user can set up a fresh Mac and extract their own completed recording without private developer intervention. The current pre-provisioned identity does not satisfy this gate.

## Desktop Reliability and Release Hardening

- Verify disconnect/reconnect, cancellation during each transfer phase, restart recovery, and duplicate imports on real hardware.
- Validate the device transfer-tail checksum algorithm in addition to existing framing, size, authentication, and Ogg integrity checks.
- Make original-sidecar persistence and metadata acknowledgement atomic under disk-full and process-crash conditions.
- Complete original-file purge behavior and test backup/restore of the full SQLite/audio vault.
- Add operation ownership so one paired client cannot cancel another client's transfer.
- Verify native physical-microphone recording, original-audio exports, and extracted-audio transcription/analysis end to end.
- Audit network authentication, redaction, pairing transport, and private-file permissions before expanding beyond trusted LAN use.
- Package external runtime dependencies predictably; sign/notarize macOS builds and test upgrades without losing recordings.
- Profile large libraries and folder scans with measured latency and memory budgets.

Exit gate: fresh-install and upgrade acceptance, no lost recordings, reproducible downloads, secure private access, and no private or proprietary artifacts in published packages.

## Android Companion

- Finish physical-device acceptance of the shared import dialog through a paired Mac.
- Add byte-offset resumable mobile uploads; current retries resend the complete file and retain local audio until acknowledgement.
- Verify offline recording/share import, playback, Markdown exports, and synchronization conflicts on real devices.
- Exercise a real Android 16 KB page-size device or emulator; alignment checks alone are insufficient.
- Broaden SDK-free direct-extraction acceptance beyond the single verified authorized Note Pro and Samsung phone.
- Validate background monitoring after battery restrictions, process death, and phone reboot. Never claim an unavailable list is empty.
- Publish a separately reviewed SDK-free APK only after release signing and fresh-install acceptance.

Exit gate: interrupted-network and offline workflows complete without data loss, tested native UI, and a separately documented result for standalone Plaud hardware extraction.

## Cross-App Synchronization and Other Platforms

- Complete queued revisions, tombstones, restore propagation, and conflict reporting across OpenPlod, OpenNotes, and OpenWhistle.
- Verify remote forwarding retries/idempotency and processing-version ownership with the real service.
- Preserve the ownership model: desktop original audio, mobile cache/outbox, processing-service results.
- Evaluate iOS and other desktop platforms only with their own native transport and acceptance evidence.

Exit gate: unavailable peers recover cleanly on reconnect, manual edits survive reprocessing, and deletion/restore semantics agree across connected applications.
