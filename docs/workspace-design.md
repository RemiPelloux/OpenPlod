# Recording Workspace

The desktop redesign uses the user-supplied 1536 x 1024 OpenPlod reference as its accepted design. It preserves the existing React, Radix, and Tauri stack. Version 0.4.0 replaces Lucide with an original, accessible SVG icon set. The interface is real application code, not a screenshot with hotspots. No example recordings, speakers, summaries, quotas, or account claims are inserted into the vault.

## Fidelity Ledger

| Area | Reference and implementation | Adjustment or intentional difference |
| --- | --- | --- |
| Shell | 230px sidebar, 60px command bar, four integration tiles | Matched pane positions and tightened tiles from 127px to 114px at the reference viewport. |
| Library | Compact list, source filters, sort, list/grid switch, selected row | 48px rows and restrained selection. Actual recording count replaces the reference's 12 example recordings. |
| Detail | Selected recording beside the list; waveform, playback, five content tabs | Actual decoded audio supplies the waveform, duration, seek position, and playback state. The audio is not a sample asset. |
| Typography | Clear 26px library heading, 22px detail title, compact controls | Raised recording titles to 14px and transcript body to 13px; corrected the logo's transparent viewBox padding. |
| Palette | Near-black canvas, charcoal chrome, blue selection, violet AI accent, green verified presence | Preserved the reference's dark direction. Light mode remains available. |
| Artwork | Plaud product image and mountain footer | Uses an official front-facing product photo and a licensed mountain photo. These are not the reference's exact angled device render or night landscape. Provenance is in THIRD_PARTY_NOTICES.md. |
| Navigation | Home, Recordings, Transcripts, Documents, AI Chat, Import, Plaud Device, Android, API & MCP, Starred, Trash | Same ordering. Android opens the pairing section. Starred and Trash have mutually exclusive selection states. |
| Responsive | Desktop list/detail becomes mobile list/detail navigation | Narrow filters fit at 320px. Short desktop windows compact integration tiles and secondary player spacing to retain readable transcript space. |

## Copy and Data Differences

- Visible navigation, primary actions, and content-tab labels follow the reference.
- The existing, explicitly requested `Get from Plaud` action stays visible above the library.
- Real device presence and verified connection status replace a permanent `Plaud Connected` claim. A battery percentage is omitted unless available from hardware.
- The configured transcription engine supplies the provider label. No universal privacy claim is made for cloud processing.
- Actual local-workspace settings replace the reference's profile photo and `Pro Plan`. A fictional storage quota is not shown.
- Transcript speakers, timestamps, text, summaries, tags, and recordings come from the private API. The reference's example content is not copied.
- Native window controls remain native; browser previews do not draw fake Mac controls.

These are explicit functional and asset differences, not a claim of literal pixel identity.

## Verification

The in-app browser was opened first. Authenticated Playwright Chrome was used for repeatable checks because the private vault's pairing credential is supplied by the native runtime, not by the unauthenticated in-app browser. The test injects that credential only into requests to the selected loopback API; it never substitutes API responses or logs the credential.

`scripts/check-workspace-ui.mjs` covers real library data, decoded waveform pixels, advancing audio playback, playback speed, Markdown export, notes/chapters tabs, the Mistral document dialog, selected-recording AI handoff, search cancellation, filtering, view changes, keyboard tabs, navigation, pairing expansion, and desktop/mobile overflow. It does not submit a new Mistral request, create a document, or delete recordings. Provider and destructive lifecycle cases are covered separately by the backend tests.

The reference and rendered screenshots were visually compared at 1536 x 1024. Additional viewports: 1440 x 900, 1180 x 900, 1180 x 752, 900 x 844, 390 x 844, and 320 x 844. Private screenshots are not committed because they contain real transcript text.

To run against an existing private vault, supply `OPENPLOD_TEST_ORIGIN` (loopback only), `OPENPLOD_TEST_TOKEN_FILE`, and an installed Playwright package via `OPENPLOD_PLAYWRIGHT_PATH` when it is not locally resolvable. `OPENPLOD_SCREENSHOT_DIR` optionally retains private screenshots. Then run `node scripts/check-workspace-ui.mjs`.

## Motion Review

| Before | After | Why |
| --- | --- | --- |
| Symmetric play-button press timing | 160ms pointer press, 100ms release, existing strong ease-out | Deliberate press feedback with a faster release; transform only. |
| Potential keyboard-triggered press movement | `:active:not(:focus-visible)` | Keyboard operation stays immediate. |
| New pointer feedback | Disabled under reduced-motion preference | No motion requirement for using playback. |

Verdict: approve the new workspace motion. There are no entrance animations on search, filters, list selection, or keyboard navigation. This is a scoped review of the redesigned workspace, not an audit of every pre-existing screen.

## Documents And Plaud Pages

The September 7 references are `codex-clipboard-74ecbd6b-1abb-44e3-8e78-2383bd211695.png` (Documents, 1586 x 992) and `codex-clipboard-5d71f581-e0f7-401b-87cb-b0b5af3aec7b.png` (Plaud, 1672 x 941). These supplied designs, rather than new generated concepts, direct this extension of the existing workspace.

| Area | Reference | Implemented and verified |
| --- | --- | --- |
| Documents layout | Folder navigation, compact list, aligned document header, editor and tool rail | Three-column desktop layout with independently scrolling document content; folder drawer and list/detail navigation on narrow screens. Corrected an extra full-width heading that displaced the editor. |
| Document typography | Clear title hierarchy and compact chrome | 24px page heading, 17px editable document title, 30px Markdown heading, 14px reading text, 11-13px controls. Long titles truncate only in navigation, not in document content. |
| Editor tools | Markdown/Preview modes, formatting, outline, export, AI | Working selection-based formatting, parser-backed heading navigation, source metadata, version history, Markdown/JSON export, configured delivery dialog, and source-recording AI handoff. No decorative/inert tools. |
| Plaud layout | Device image and facts beside connection health; recordings beside vault/preferences | Actual product photo, separate discovery/access states, selectable session imports with confirmation and cancellation, vault statistics, processing switches, and phone authorization. |
| Color and buttons | Dark surfaces with blue selection and semantic status | Uses the current app's neutral dark/light tokens and compact monochrome command buttons, blue selected states and switches, green verified states. No new page-specific theme. |
| Responsive | Desktop-oriented references | Checked at reference dimensions, 1180px, 900px, 390px, and 320px. Fixed compressed Plaud heading and document-command wrapping. |
| Motion | Immediate task interactions | No page entrances or animated list selection. Only the switch thumb moves, for 140ms, with movement removed under reduced-motion preference. |

Intentional copy/data differences: the reference's sample documents, folders, counts, battery percentage, firmware, storage capacity, profile, and permanent "Healthy" claim are not inserted. Unknown device access remains unknown. The saved-recordings count is explicitly the whole vault, not an unsupported per-device total. Source originals are always retained, so this is a fixed fact rather than a misleading deletion switch. The AI shortcut uses the document's real source recording; standalone Markdown does not claim unsupported document-context AI. Automatic summaries use existing recording processing, not an invented automatic Markdown-generation pipeline.

The in-app browser was checked first; repeatable authenticated checks used Playwright Chrome because pairing is supplied by the native runtime. The original references and final renders were inspected with `view_image`, including native-size, compact, mobile, light-mode, and outline screenshots. Private transcript screenshots are not committed. The comparison covered column geometry, header alignment, type hierarchy, palette, button/icon treatment, product framing, content density, and responsive wrapping. Remaining differences above are intentional; this is not a claim of literal pixel identity.

`scripts/check-documents-device-ui.mjs` verifies real document loading, formatting, outline anchors, source panel, Markdown export, history/send dialogs, unsaved-draft discard, mobile folder navigation, responsive boundaries, real product image loading, unknown device counts, cancellation, and reduced motion. `OPENPLOD_TEST_MUTATIONS=isolated-snapshot` enables versioned-save and processing-preference checks only on the private 3492 snapshot; original values are restored afterward. The live vault and its audio are not changed. No device import or external delivery is submitted by this suite. New unit tests cover formatting boundaries and parsed headings, including code fences, nested headings, and duplicate titles. This UI verification does not constitute a new hardware extraction acceptance test.
