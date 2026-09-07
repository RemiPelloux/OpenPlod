# Security Policy

OpenPlod is experimental. The latest prerelease is the active development target; there is no support SLA or independent security certification.

## Report Privately

Use [GitHub private vulnerability reporting](https://github.com/RemiPelloux/OpenPlod/security/advisories/new). If unavailable, contact the maintainer through [their GitHub profile](https://github.com/RemiPelloux) to arrange a private channel before sharing details. Do not open public issues containing exploit instructions or sensitive artifacts.

Include the affected version, platform, impact, a minimal reproduction using non-sensitive files, and redacted diagnostics. Never send account passwords, API keys, pairing tokens, device identities, private audio, or production databases.

## Trust Boundaries

- The desktop vault is local, but is not encrypted by OpenPlod. Use OS disk encryption and protected backups.
- Native desktop APIs require a private token. LAN pairing uses HTTP; use trusted networks, not public port forwarding.
- Source-run development without a token is loopback-only by default. Configure authentication before allowing remote access.
- Cloud transcription sends audio to the selected provider. Document generation sends transcript text to Mistral. MCP clients may send requested content to their own model providers.
- Markdown/transcripts are untrusted data. They must never become executable HTML, shell commands, or privileged agent instructions.
- Webhook destinations are explicitly configured by the vault owner. A failed response does not prove delivery did not happen; uncertain sends must not be silently retried.
- Device authorization belongs to the device owner. Detection is not permission to access recordings or modify ownership.

Release checksums detect accidental corruption and identify published bytes; they do not replace code signing or notarization. Current Mac builds are ad-hoc signed, not notarized. Trash and purge are not certified secure erasure.
