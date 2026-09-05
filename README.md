<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="OpenPlod icon" width="80" height="80" />
</p>

<h1 align="center">OpenPlod</h1>
<p align="center">A local recording vault for your Plaud, audio, and Markdown transcripts.</p>
<p align="center">
  <a href="#get-started">Get started</a> &middot;
  <a href="#get-recordings-from-plaud">Plaud connection</a> &middot;
  <a href="#android-companion">Android</a> &middot;
  <a href="ROADMAP.md">Roadmap</a> &middot;
  <a href="https://github.com/RemiPelloux/OpenPlod/issues">Report an issue</a>
</p>

OpenPlod brings recording, playback, transcription, and export into one desktop-first workspace. The Mac app owns the durable audio vault; the Android companion connects to it over your private network. Keep recordings on your Plaud, keep a copy on your computer, and work with transcripts as documents.

**Version 0.2.0 is an experimental developer build, not a general-availability release.** Direct Bluetooth extraction has been verified on one authorized Plaud Note Pro and an Apple Silicon Mac. Compatibility with other devices and firmware is not established. Initial desktop device authorization still requires a privately provisioned identity; there is no self-service authorization wizard yet.

![Get from Plaud: select new recordings, see saved items, and import into the vault](docs/images/plaud-import.png)

*Import dialog with synthetic test data. No private audio, credentials, or account information is included.*

## What You Can Do

- **Get recordings from Plaud.** Open **Get from Plaud** in Library or New Recording, connect, select recordings, and import them. Filter New/Saved, sort by size, cancel the remaining batch, retry, restore a saved item from Trash, or open it in the library.
- **Keep your audio.** Import files, capture microphone audio, or receive recordings from the paired mobile app. The vault tracks stable recording IDs, content fingerprints, and source provenance.
- **Work in Markdown.** Browse the Transcripts tab, read and edit documents, inspect generated and manual versions, and export Markdown, plain text, or JSON. Reprocessing adds a generated version without silently replacing a manual edit.
- **Listen and organize.** Play and seek audio, rename recordings, edit metadata, tags, context, and notes, and use Trash to restore deleted items during the 30-day retention period.
- **Choose processing.** Use Mistral Voxtral, local whisper.cpp, or Deepgram. Configure an analysis provider for summaries and action items, or optionally forward recordings to OpenWhistle.
- **Use the same workspace on Android.** QR pairing, microphone capture, audio share/import, transcript views, and the shared Plaud import dialog are included. Mobile transfers retain local audio until the desktop acknowledges storage.

The interface uses a shared React design with light/dark themes, accessible dialogs, keyboard navigation, and reduced-motion support.

## Current Support

| Capability | Status in 0.2.0 |
| --- | --- |
| macOS desktop vault | Built and tested on Apple Silicon |
| Mac -> Note Pro Bluetooth download | Real recording listed, downloaded, decoded, imported, and played; source session retained |
| Account-free initial authorization | Not verified; the successful test used existing account authorization for device keys |
| Android -> paired Mac -> Note Pro | Shared import UI implemented; final on-phone interaction acceptance remains incomplete |
| Standalone Android -> Note Pro | Experimental official-SDK adapter; hardware extraction not verified |
| Android native-library alignment | APK ZIP and ARM64 libraries pass 16 KB alignment checks; runtime on a 16 KB device still unverified |
| iOS, Windows, Linux direct extraction | Not verified; the current direct transport requires macOS CoreBluetooth |
| Signed store-ready distribution | Not available; build from source |

## Get Started

### Build the Mac App

Install [Bun](https://bun.sh), [Rust](https://rustup.rs), Apple's Xcode Command Line Tools, and the [Tauri macOS prerequisites](https://v2.tauri.app/start/prerequisites/). Direct extraction also needs `swift`, `ffmpeg`, and `ffprobe` available to the app process; these tools are not bundled.

```bash
xcode-select --install
brew install ffmpeg

git clone https://github.com/RemiPelloux/OpenPlod.git
cd OpenPlod
bun install --frozen-lockfile
bun install --cwd web --frozen-lockfile
bun run tauri:build --bundles app
```

The app is built at `src-tauri/target/release/bundle/macos/OpenPlod.app`. Open it from there or place it in Applications. This build is not notarized. Grant Bluetooth access when macOS asks; microphone capture needs its own permission.

The native app starts its own Bun service on port **3487**. Do not run a second backend on that port at the same time.

### Get Recordings From Plaud

1. Authorize the Note Pro for this Mac. The current adapter reads a private `plaud-device.json` from the vault directory; see [device authorization](#device-authorization).
2. Wake the Plaud and keep it near your Mac. Disconnect other clients that may be holding its Bluetooth connection.
3. Open **Library** or **New Recording**, then **Get from Plaud**.
4. Select **Connect** to read the actual device list. A failed or unavailable query is an error, not a claim that there are zero recordings.
5. Select completed recordings and choose **Import**. Progress counts completed recordings, not transferred bytes.
6. Open the saved recording to play it, edit its details, transcribe it, or export a document.

Audio travels directly from the device over Bluetooth. The verified extraction did **not** download audio from Plaud's cloud or transfer it through a phone. The adapter checks transfer framing, size, authenticated decryption, decoded Ogg integrity, and playable duration. It preserves device bytes and decoded audio alongside an M4A playback copy, then checks that the source session is still listed on the Plaud. The device's transfer-tail checksum is retained but its algorithm is not yet validated.

The extraction command set excludes force-clear, ownership reset, and device-file deletion. The folder-import setting for deleting source files is separate from direct Bluetooth imports.

#### Device Authorization

The successful hardware test used the device owner's existing binding credential and signed identity. **Bluetooth discovery alone does not grant recording access.**

The private identity contains the Mac's peripheral identifier, device serial, binding token, signed authorization, and RSA key pair. The default native Mac location is:

```text
~/Library/Application Support/com.openplod.vault/plaud-device.json
```

The file must be owned by the current macOS user with permissions `0600`. For a source-run backend, `OPENPLOD_DEVICE_IDENTITY` can select an absolute path. No identity, account password, embedded vendor secret, or APK is distributed in this repository. Generating a random token or using Android developer credentials does not provision this desktop identity.

**Fresh-install limitation:** obtaining this identity is not yet a supported in-app onboarding flow. Until that is implemented, a new user can use the recording vault and file imports but should not expect plug-and-play Plaud extraction. Do not reset or rebind a device to work around authorization errors.

### Transcription and Exports

In **Settings**, choose **Mistral Voxtral** and enter your own API key. Local whisper.cpp and Deepgram are alternatives. The router tries the selected engine first, then available fallback engines. If audio must remain entirely local, leave cloud provider keys unset and disable OpenWhistle forwarding.

| Provider | Runs where | Setup |
| --- | --- | --- |
| Mistral Voxtral | Mistral cloud | API key in Settings or `MISTRAL_API_KEY` |
| whisper.cpp | Your computer | Install whisper.cpp and configure its model; see [adapter](src/transcription/whisper.ts) |
| Deepgram | Deepgram cloud | API key; supports speaker diarization |
| Summaries/action items | Configured OpenAI-compatible endpoint | `LLM_API_KEY` or `OPENAI_API_KEY`; optional `LLM_BASE_URL` and `LLM_MODEL` |

A Mistral transcription key does not automatically configure summaries. Cloud transcription sends audio to that provider; analysis sends transcript text. These are separate from downloading audio off the Plaud.

Open a recording or the **Transcripts** tab to preview Markdown, edit a transcript, inspect version history, or export Markdown, text, JSON, and library audio. The selected transcript version is included in document exports. For direct Plaud imports, library audio is the M4A playback copy; byte-for-byte device originals live separately under `recordings/originals/`.

### Android Companion

The Android app is updated to **0.2.0** and uses the same recording workspace.

1. Keep the desktop app open and put both devices on a trusted private network.
2. Open desktop **Settings** to display the pairing QR code.
3. Scan it in the Android app. Manual address/token entry is a fallback.
4. Use **Get from Plaud** to access the Mac's adapter. Keep the Plaud near the **Mac**, not just the phone; the dialog explicitly says **Via your paired Mac**.

Mobile-to-desktop uploads verify fingerprints and retain phone audio until durable acknowledgement. Interrupted uploads currently retry the whole file; byte-offset upload resumption is not implemented. The separate native Android Plaud tab uses the official developer SDK and is experimental, not evidence of working standalone extraction.

To build Android, install JDK 17, Android SDK 36, Android NDK, and the [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/#android). Configure `JAVA_HOME`, `ANDROID_HOME`, and `ANDROID_NDK_HOME` for your installation. The verified build used NDK `28.2.13676358`.

```bash
# Read the SDK's distribution terms before fetching or packaging it.
bun run scripts/fetch-plaud-sdk.ts
bun run tauri android build --debug --target aarch64 --apk --ci
bun run check:android
```

The debug APK is produced under `src-tauri/gen/android/app/build/outputs/apk/universal/debug/`. The fetch script pins and checksums the SDK; its binary is ignored by Git. Developer authentication variables in [.env.example](.env.example) apply to the experimental Android SDK route, not desktop authorization. Do not reset device ownership to test that route.

## Data and Privacy

The native Mac vault is stored at:

```text
~/Library/Application Support/com.openplod.vault/
  openplod.db              Recording metadata, transcripts, versions, settings
  recordings/             Library audio
    originals/            Direct-import originals and provenance
  pairing-token           Private desktop/mobile pairing credential
  plaud-device.json       Private desktop device identity, when provisioned
```

- **Back up the entire vault**, not just the app bundle. Quit OpenPlod before making a filesystem copy so SQLite and audio are consistent. Never delete the vault to upgrade the app.
- **Local storage is not encrypted by OpenPlod.** Protect your OS account, use FileVault where appropriate, and secure backups. API keys are stored locally; Settings returns only whether a key is configured.
- **Keep the service private.** The native app listens on the LAN for pairing and protects `/api` with its token. LAN HTTP is not end-to-end encrypted. Do not port-forward it or expose it to the public internet; use a trusted network or a separately secured tunnel.
- **Trash is not device deletion.** Library records can be restored for 30 days. Expired-trash cleanup runs when the backend starts. Original-sidecar cleanup and cross-peer deletion propagation still need hardening; do not treat purge as certified secure erasure.
- **Do not publish private artifacts.** Credentials, pairing QR codes, vault databases, recordings, SDK binaries, APK snapshots, and local investigation notes are excluded from the source publication.

## Development

The shared frontend is React, TypeScript, Tailwind CSS, Radix UI, and Lucide. Tauri supplies the native shell. The backend uses Bun, Hono, Drizzle, and SQLite. The Mac transport uses Swift/CoreBluetooth, native RSA, and ChaCha20-Poly1305 session encryption.

```text
web/src/                 Shared recording, transcript, settings, and import UI
src/api/                 Recording, mobile, Plaud, and transcript endpoints
src/library/             Durable imports, provenance, versions, forwarding
src/sync/                Bluetooth protocol, transport, audio, folder adapters
src/transcription/       Mistral, whisper.cpp, and Deepgram adapters
src-tauri/               Native shell and platform integrations
scripts/                 Swift bridge, SDK fetch, build and alignment checks
```

For browser development, quit the native app first, then use two terminals:

```bash
# Terminal 1: backend at http://127.0.0.1:3487
bun run dev

# Terminal 2: UI at http://127.0.0.1:5173, proxying /api to the backend
bun run dev:web
```

The source-run backend defaults to loopback and `./data`; unlike the native app, it does not automatically configure a pairing token. Set `OPENPLOD_PAIRING_TOKEN` before binding it to other interfaces. Use `.env.example` as a reference and keep actual credentials in an ignored `.env` file. For native development, run `bun run tauri:dev` instead of the two-terminal setup.

Docker is available for the web vault and file-based imports via `docker compose up --build` at `http://localhost:3456`. **Docker on macOS does not provide the native CoreBluetooth extraction route.** Its default published port is not a public deployment configuration; restrict access before running it on a shared host.

### Quality Checks

```bash
bun test
bun run typecheck
bun run --cwd web lint
bun run build
bun run tauri:build --bundles app

# After an Android APK build, with ANDROID_HOME configured:
bun run check:android
```

The 0.2.0 validation run passed **50 Bun tests**, type checking, frontend lint/build, the macOS build, Android build, and APK/native-library alignment checks. Browser fixtures covered batch imports, cancellation, retry, filtering, sorting, Trash restore, focus return, and empty/error states at 1440x900, 390x844, and 320x740.

Hardware evidence is separate: one approximately 76-second Note Pro recording was downloaded directly on Mac, decoded, imported, and played, and its source session was still present. This does not establish compatibility across devices or replace interrupted-transfer and fresh-install acceptance. The final installed-phone touch-flow check remains incomplete. See [ROADMAP.md](ROADMAP.md) for outstanding gates.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Plaud is visible but recordings are unavailable | Presence is not authorization. Confirm the private identity, Bluetooth permission, and that another client is not holding the device. |
| "Authorize this Note Pro on this Mac" | Desktop identity provisioning is incomplete; Android developer credentials are a different route. |
| Audio verification or conversion fails | Ensure `ffmpeg` and `ffprobe` are accessible to the app process. Finder and terminal environments may differ. Keep the source on the Plaud. |
| Phone cannot reach the vault | Keep the Mac app open, check the local address/firewall, use the same private network, and rescan the pairing QR. |
| Transcription fails | Check the selected engine and credentials. A saved recording is retained independently of processing success. |
| Startup cannot reach the local service | Check for another process on port 3487. Do not run native and development backends together. |
| Android reports a 16 KB alignment error | Rebuild current sources and run `bun run check:android`; older APKs used an incompatible native encoder. |

## Contributing

Open an issue with your OS, app version, device model/firmware, reproducible steps, and redacted errors. Clearly distinguish fixtures from actual hardware tests. Do not attach passwords, device identities, private audio, pairing QR codes, or proprietary app files. Keep changes focused and run relevant checks before opening a pull request.

## Credits and Licensing

OpenPlod builds on [jddavenportOpen/openplaud](https://github.com/jddavenportOpen/openplaud). Its upstream README declares MIT, but the inherited repository does not include a standalone license file; licensing provenance should be clarified before relying on a complete redistribution grant. This publication does not relicense third-party material.

The experimental Android adapter uses the [Plaud developer SDK](https://github.com/Plaud-AI/plaud-sdk-public), whose terms are separate. Its binary is not included here; review its redistribution terms before sharing compiled Android builds containing it.

OpenPlod is an independent project, not affiliated with or endorsed by Plaud. Product names and trademarks belong to their respective owners.
