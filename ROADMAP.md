# OpenPlod Roadmap

Updated September 5, 2026 for the 0.2.0 source publication. Desktop remains the primary audio owner; Android is an experimental companion. A build or simulated response is not a hardware acceptance result.

## Delivered in 0.2.0

- Direct Mac-to-Note-Pro Bluetooth session, authenticated listing, offset-based download, decoding, and durable library import.
- One real recording downloaded, played, and checked for source retention on an authorized Note Pro. Account authorization supplied keys; no cloud audio download or phone audio relay was used.
- Preserved encrypted device original, decoded Ogg audio, playback copy, SHA-256, and source provenance.
- Shared Get from Plaud dialog in Library and New Recording: selection, New/Saved filtering, sorting, sequential imports, cancellation, retry, Trash restore, and open-recording links.
- Markdown transcript library, manual/generated version history, document exports, metadata editing, audio playback, and Trash controls.
- Mistral transcription adapter, optional local/Deepgram processing, and OpenWhistle forwarding.
- Updated Mac and Android 0.2.0 builds. Mobile's shared import dialog uses the paired Mac's Bluetooth adapter.

Validation: 50 Bun tests; TypeScript and frontend lint/build; macOS and Android builds; APK ZIP and ARM64 library 16 KB alignment; responsive browser-fixture checks at three viewport sizes. Existing native document export and synthetic-speech Mistral checks passed earlier in development. Final installed-phone touch-flow acceptance is incomplete.

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
- Keep standalone Plaud extraction explicitly experimental until the official-SDK route lists, downloads, plays, and retains a real device recording.
- Resolve SDK licensing before distributing binaries containing it.

Exit gate: interrupted-network and offline workflows complete without data loss, tested native UI, and a separately documented result for standalone Plaud hardware extraction.

## Cross-App Synchronization and Other Platforms

- Complete queued revisions, tombstones, restore propagation, and conflict reporting across OpenPlod, OpenNotes, and OpenWhistle.
- Verify remote forwarding retries/idempotency and processing-version ownership with the real service.
- Preserve the ownership model: desktop original audio, mobile cache/outbox, processing-service results.
- Evaluate iOS and other desktop platforms only with their own native transport and acceptance evidence.

Exit gate: unavailable peers recover cleanly on reconnect, manual edits survive reprocessing, and deletion/restore semantics agree across connected applications.
