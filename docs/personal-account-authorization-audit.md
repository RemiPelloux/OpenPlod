# Personal-account authorization and resilient imports

## Upstream review and scope

Reviewed OpenPlod main `d7826e87a842e6f16913816a4a5978b4cb3bec41`, issues #2/#3 and open PR #4 on November 15, 2026. PR #4 addresses the original Plaud Note, not this personal-account Note Pro flow. No covering change was integrated. Decision: retain the local implementation and the existing React/Radix/Tauri and Bluetooth architecture.

Reference: [Plaude Archiver](https://github.com/roopen219/plaude-archiver), revision `e87f34536623b204a60296057e53d7747ac1e0d3`, particularly PlaudAPI.swift, LoginWindow.swift, Crypto.swift and BLE.swift. Its MIT notice is retained in THIRD_PARTY_NOTICES.md. No proprietary SDK is added.

## Final implementation

- Desktop personal accounts use a private integrated Plaud window, including Google provider popups. The popup shares its opener session. Provider popup creation and navigation enforce an HTTPS origin allowlist, including Google's published regional account hosts. The main sign-in window allows any HTTPS navigation and does not apply that provider allowlist. Diagnostics omit OAuth paths and credentials. Only the Plaud account cookie is returned to the trusted local main window. No extension, browser-profile access or token copying is required.
- Consumer authorization uses regional `/device-app/device/sn-sign` and `/device-app/e2ee/gen_key` endpoints. It checks the encrypted envelope MAC with an application-embedded public key and validates matching RSA-2048 keys. Because that envelope key is public, its MAC does not authenticate Plaud as the sender; server authentication depends on TLS. Partner/developer authorization remains the default for existing API callers omitting accountType.
- macOS uses a bundled Foundation URLSession helper because identical unauthenticated probes received an HTML403 with Bun but the expected API401 with Foundation. This is transport evidence, not proof of an invalid account token. The helper enforces hosts, paths, HTTPS, input/response bounds, no redirects, normal TLS validation, timeout and cancellation. Credentials travel through stdin, not arguments or logs.
- Authorization operations are serialized and cancellable. Local keys are written with private permissions and atomic replacement. Removing authorization cancels pending work and removes only local authorization files.
- macOS recorder selection uses the CoreBluetooth UUID. btleplug 0.11.8 address() returns a shared zero address on macOS; that address must never identify an exact device. Existing zero-address identities can rediscover a Plaud candidate.
- Buffered imports replace the former 64 MiB cap with memory admission and disk checks, preserve resumable local checkpoints and use inactivity deadlines. The decoder still holds complete buffers; this is not unlimited-size streaming.
- FFmpeg conversion uses progress-based inactivity detection, bounded diagnostics and cancellation. The former fixed 45-second deadline could stop a conversion that was still progressing.
- Both desktop import entry points display the current phase, received bytes, measured step percentage and explicit reuse of local data. Unmeasured phases remain indeterminate. The ring supports reduced motion and accessible progress semantics.
- Plaud errors are localized at the UI boundary. Provider-neutral errors never assume Google or direct desktop users to copy cookies.

## Preservation and privacy

No bind/reset, firmware, clear-storage or delete-recording command is introduced. Imports retain device originals and save original encrypted bytes, decoded audio and provenance alongside playback audio. Tests use synthetic keys and isolated storage. No owner credentials, serial, recordings, database or private screenshots belong in commits.

## Real hardware evidence

Hardware validation covered macOS Apple Silicon and a Plaud Note Pro: authorization, encrypted imports, checkpoint reuse, playback and preservation of device originals. Personal sign-in details and recording metadata are intentionally omitted.

Firmware version was not captured. These results do not establish Windows/Linux hardware support, Apple sign-in, all Google challenge variants or recovery from every possible interruption. No claim of checksum-algorithm verification is added: the transfer-tail algorithm remains unconfirmed upstream; the decoded Ogg integrity checks are enforced.

## Automated verification

The compliance follow-up passed 629 Bun tests (5,016 assertions) on the CI-pinned 1.3.14, TypeScript, ESLint, frontend build, macOS bridge Clippy with warnings denied, eight native application tests and two bridge tests. The optimized Swift helper passed its URL self-test and nine rejected-input checks without network requests.

The compliance follow-up adds optimized Swift helper checks, native authorization tests to macOS CI, bridge unit tests to the platform matrix, localization regressions and isolated UI scenarios. UI fixtures are synthetic and do not contact a recorder, Google/Plaud, or the owner's vault. The UI suite covers desktop and narrow widths, both themes, keyboard focus, reduced motion, accessibility, stage percentages and reuse labels. The matrix includes 16 device-page scenarios (320, 390, 1180 and 1440 pixels; light/dark; reduced/default motion) and four desktop dialog scenarios. Narrow layouts put cancellation below the progress text so it remains readable. Current command results are recorded in the pull request, not inferred from earlier builds.

## Remaining compatibility boundaries

The consumer endpoints are observed vendor behavior rather than a supported public device API. Changes may require maintenance. Google can alter sign-in requirements. Authorization and hardware import on Linux/Windows remain unverified; CI builds do not substitute for hardware acceptance. Distribution remains ad hoc and not notarized unless release signing credentials are configured. The inherited-license caveat in LICENSING.md remains unchanged.


## PR review follow-up — November 15, 2026

Reviewed all 11 inline findings on PR #5 against `ef91e4d`. Upstream main remains
`d7826e87`; PR #4 is still open and does not replace this implementation. Decision:
retain the existing flow and patch the confirmed compatibility and cancellation gaps.
The installed Tauri 2.12.5/Wry 0.57.2 sources confirm that Windows popup environment
sharing does not copy controller incognito mode, and that private mode requires
WebView2 101.0.1210.39. The README now states that runtime requirement explicitly;
older Windows runtimes are not covered by the cookie-persistence guarantee.

The follow-up preserves MAC addresses in non-macOS scans, matches Windows popup
private mode, forwards partner-request cancellation, invalidates identity requests
that predate a clear, checks cancellation after hashing, separates regional routing
from transient retries, and excludes local checkpoint I/O from receive inactivity.
Completed UI authorization releases ownership before handing off to the recording
list. Narrow dialog progress occupies its own row. The envelope MAC limitation is
now explicit above.

Validation: 634 Bun tests pass, including deterministic memory admission, regional
routing after HTTP 503, partner request abortion, stale authorization generations,
slow checkpoints and Linux scan formatting. TypeScript, ESLint, frontend build,
eight native application tests, two bridge tests and bridge Clippy pass on macOS.
The isolated UI matrix includes 16 device-page scenarios, eight dialog scenarios
(including 320/390 px) and authorization handoff without spurious cancellation.
GitHub Actions still requires maintainer approval for the external contribution;
local results do not imply successful Windows/Linux CI or hardware acceptance.
