# Third-Party Notices and Distribution Boundaries

This file records provenance; it does not relicense third-party work or certify that all redistribution obligations have been independently reviewed.

Original OpenPlod contributions are available under [MIT](LICENSE). See [LICENSING.md](LICENSING.md) for the exact scope and inherited-code limitation.

## Upstream Project

OpenPlod derives from [jddavenportOpen/openplaud](https://github.com/jddavenportOpen/openplaud). The upstream README declares MIT, but no standalone upstream LICENSE file was available at publication time. Existing authorship and git history are retained. Clarify the inherited grant before relying on a blanket project license; the package metadata alone is not a replacement for the original license notice.

## Plaud SDK

Current Android source no longer depends on or packages this SDK. The direct adapter uses platform Bluetooth/JCA APIs, OkHttp, and Bouncy Castle (`bcprov-jdk18on` 1.80, under its own license). The following records the boundary for historical development builds and the retained optional fetch script.

The Android fetch script pins [Plaud-AI/plaud-sdk-public](https://github.com/Plaud-AI/plaud-sdk-public) at `c5111a44938b8739313dcb5f105f696c6af8ad8d` and verifies the AAR checksum before use.

The LICENSE at that revision is Apache-2.0 for repository materials, followed by an explicit exception: SDK binaries in `sdk/`, including Android `plaud-sdk.aar`, are proprietary and distributed under a separate license. The public release therefore does not contain the AAR or an APK embedding it. A local development installation does not imply public redistribution permission. The native Mac adapter does not embed that Android SDK.

## Runtime Dependencies

JavaScript and Rust dependencies retain their individual licenses. Refer to `bun.lock`, `web/bun.lock`, `src-tauri/Cargo.lock`, and each package's license files for exact versions and terms. Bun, Tauri, React, Hono, Radix UI, SQLite, and the other libraries are not relicensed by the OpenPlod brand assets or README. Version 0.4.0 replaces Lucide with original custom SVG icons; earlier distributions retain their original dependency obligations.

The Mac release uses Bun's compiled runtime and a Tauri native shell. ffmpeg/ffprobe, Swift tooling, and transcription models are external prerequisites, not bundled downloads. The release archive includes a dependency-license inventory and available dependency license/notice texts alongside the app.

## Workspace Images

- `web/public/plaud-note-pro.png`: official Plaud Note Pro product photograph, retrieved from the [Plaud storefront CDN](https://cdn.shopify.com/s/files/1/0918/0171/5051/files/NotePro-_-2_fdc31980-a483-420d-b385-3723c698c9b7.png?v=1779783768&width=240). Cropped to remove transparent padding. Copyright remains with its owner; used to identify the supported device, not as original OpenPlod artwork. No broader redistribution license is asserted.
- `web/public/mountains.jpg`: mountain photograph from [Unsplash](https://images.unsplash.com/photo-1464822759023-fed622ff2c3b), used under the [Unsplash license](https://unsplash.com/license). Displayed as a subdued workspace footer background.

## Trademarks

OpenPlod is independent of Plaud, Mistral, Deepgram, OpenAI, and the other named vendors. Names are used to describe interoperability and provenance, not endorsement. The new OpenPlod vector mark is original project artwork, not a modified Plaud logo.
