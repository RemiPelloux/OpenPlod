# Signed updates for personal desktop builds

Build the first personal installer with a public updater key and a stable HTTPS manifest URL. Set `OPENPLOD_UPDATE_ENDPOINT` to that URL in the release environment (or as a repository variable in the fork). Set `TAURI_UPDATER_PUBKEY` and `TAURI_SIGNING_PRIVATE_KEY` from the same Tauri signing key pair. Keep the private key and its password outside the repository. The official endpoint stays the default for builds without a channel override.

Publish the signed macOS updater archive and its signature, and then publish the matching manifest at that URL. Use increasing versions and preserve the app bundle identifier across releases. Existing builds without an embedded key must be replaced manually once. A DMG alone is not an updater package.

OpenPlod checks for signed updates at startup and downloads them before offering installation. Automatic installation on next launch is off by default. The Tauri download is held by the running process: with automatic installation enabled, a previously downloaded version is downloaded and verified again at next launch. A different advertised version still requires a decision on that launch. A failed installation does not trigger an automatic relaunch or immediate retry.
