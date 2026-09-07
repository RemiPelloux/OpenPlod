# Contributing to OpenPlod

Start with an issue describing the user workflow, platform, and expected result. Small, focused pull requests are easier to verify. Desktop audio retention is the primary invariant; the Android companion must not discard an unacknowledged recording.

## Development

Install Bun, then run `bun install --frozen-lockfile` and `bun install --cwd web --frozen-lockfile`. Follow the [README](README.md#development) for native prerequisites and service startup. Never point automated tests at your everyday recording vault.

Before submitting:

```bash
bun test
bun run typecheck
bun run --cwd web lint
bun run build
```

For native changes, also build the affected platform. Android changes require `bun run check:android` after building the APK. UI changes need narrow/mobile and desktop checks, keyboard navigation, both themes, and reduced-motion support. CI checks source behavior; it does not establish Bluetooth hardware compatibility.

## Data and Protocol Boundaries

- Keep original audio and provenance. Transcript reprocessing creates versions; it must not erase a user edit.
- Reject stale revisions and preserve tombstones. Never silently overwrite another client's changes.
- Keep Bluetooth presence separate from authorization and successful transfer. Report unavailable lists as unknown/errors, not zero recordings.
- Only implement device commands backed by inspected protocol evidence and authorized hardware tests. No ownership resets, force-clear commands, firmware flashing, or guessed writes.
- Use real providers in production. Test doubles belong only in isolated automated tests; preview images must be real captures, clearly redacted where needed.
- Keep API tokens, keys, serials, signed identities, recordings, databases, APK investigation files, and proprietary SDK binaries out of commits and public logs.

## Pull Requests

Explain what changed, why, and how it was verified. Document compatibility changes and known gaps. A passing unit test is not a hardware acceptance result. Report device model/firmware without unique identifiers. Confirm third-party licensing before adding or distributing dependencies.

For vulnerabilities, follow [SECURITY.md](SECURITY.md). For sponsorship or maintainer contact, visit [Remi Pelloux](https://github.com/RemiPelloux).
