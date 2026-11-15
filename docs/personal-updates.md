# Signed updates for personal desktop builds

Build the first personal installer with a public updater key and a stable HTTPS manifest URL. Set `OPENPLOD_UPDATE_ENDPOINT` to that URL in the release environment (or as a repository variable in the fork). Set `TAURI_UPDATER_PUBKEY` and `TAURI_SIGNING_PRIVATE_KEY` from the same Tauri signing key pair. Keep the private key and its password outside the repository. The official endpoint stays the default for builds without a channel override.

Publish the signed macOS updater archive and its signature, and then publish the matching manifest at that URL. Use increasing versions and preserve the app bundle identifier across releases. Existing builds without an embedded key must be replaced manually once. A DMG alone is not an updater package.

With a signed update channel configured, OpenPlod checks for updates before opening the workspace. By default it downloads and installs any available update, then relaunches. A network or verification failure allows the current version to open. An installation that fails or leaves the same version in place is not attempted automatically again for that version. The Settings switch turns off automatic installation and leaves the download and manual confirmation available.
