# Verified single-recording deletion

## Upstream decision (2026-11-15)

Reviewed OpenPlod main `d7826e87a842e6f16913816a4a5978b4cb3bec41`, open PRs #4 and #5, and issues #2 and #3. No integrated single-recording deletion workflow covers this request. Preserve the local authorization/import work at `a842cf0c824dc34d192d7cb9fda240f9a14bb6be`; implement this feature on a separate branch.

Protocol evidence: [plaude-archiver Protocol.swift](https://github.com/roopen219/plaude-archiver/blob/e87f34536623b204a60296057e53d7747ac1e0d3/PlaudeArchiver/Sources/PlaudeArchiver/Protocol.swift) and `BLE.swift` at the same revision: command 30 carries a little-endian session ID; response 31 carries the echoed session ID and status at byte 7 for protocol >= 7. Reuse this documented framing, adapted to OpenPlod's negotiated protocol 20 with strict response validation. No new dependency. No clear-all, reset, cloud deletion, or automatic deletion.

## Acceptance boundary

The desktop owner verifies the saved playback and device-original hashes, then explicitly confirms one session. Confirmation is short-lived and single-use. Recheck the backup and exact device session before sending. Protect the backup against application purge/replacement while checking and deleting. Never retry a destructive command automatically. Confirm acknowledgement and absence from a fresh device list; otherwise report an uncertain result.

Use existing buttons, Radix dialog, theme tokens, translations and keyboard focus behavior. Validate narrow/desktop layouts, both themes and reduced motion with simulated API responses.

The user prohibits deletion on their recorder during tests. All deletion tests therefore use synthetic files and simulated transports. Passing tests do not establish hardware compatibility; no destructive hardware acceptance is claimed. Imports continue to retain device originals. Explicit confirmed deletion removes only the selected device copy, retaining local audio and provenance.

Legacy imports without a playback hash are eligible only at revision 1. Edited legacy copies must be imported again; the device source remains intact when verification fails. New imports retain the playback hash in provenance. The application lease protects against concurrent application operations, not external filesystem edits or disk failure.

## Validation

- `bun test`: 668 passed, 0 failed, 5165 assertions. Includes 34 dedicated deletion/authorization tests on synthetic files and transports.
- `bun run typecheck`, `bun run --cwd web lint`, `bun run build`: passed. Vite still reports its existing large-chunk advisory.
- `bun scripts/check-plaud-ui.mjs`: all 16 combinations of 320/390/1180/1440 px, light/dark and reduced/default motion passed, including existing import/resume cases. Deletion checks cover initial safe focus, Escape cancellation, focus return, failed verification, uncertain deletion, explicit reconfirmation, successful removal from the list, no overflow and no serious/critical axe findings. Desktop and 320px screenshots were visually inspected.
- No native source or dependency changed. No DMG was rebuilt for this feature. No live recorder, everyday vault or external provider was used by the deletion tests.

The feature is isolated on `codex/plaud-verified-delete`; the existing authorization PR is not expanded with this workflow. Hardware acceptance remains outstanding because the user explicitly prohibited deleting a device recording during tests.
