# AI Providers

This page describes the AI providers OpenPlod can use, what each one receives, and the controls around cost, long audio, fallbacks, and cancellation. It started as the 0.5.0 implementation status and is kept current. No live-provider success is claimed for any release: adapters, chunking, fallbacks, cost gating, and remote cancellation are contract-tested against recorded request and response shapes with injected fetchers and splitters, not against live provider APIs or real long recordings. The public package is macOS Apple Silicon only; the Android debug build remains a local development artifact.

## Setup

Open Settings > AI providers. Speech-to-text receives audio; summaries, documents, and chat receive text. Set each task's provider/model separately and press Save AI. API keys remain server-side; GET settings exposes only configured flags. Blank untouched fields preserve saved keys. The API accepts an explicit empty credential to clear a saved value; environment credentials (`MISTRAL_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) remain a fallback, except for the custom endpoint.

| Task | Implemented adapters | Important limits |
| --- | --- | --- |
| Transcription | Mistral Voxtral, Whisper.cpp, Deepgram, OpenAI, AssemblyAI | OpenAI rejects files over 25 MB and AssemblyAI is capped at 100 MB by OpenPlod; larger files are split into chunks where the provider allows it (see [Long Audio](#long-audio)) |
| Summaries, documents, cited chat | Mistral, OpenAI, Anthropic, Gemini, Ollama, a custom OpenAI-compatible endpoint | Complete results required (an incomplete or empty answer is an error). No fabricated fallback response. Input-size bounds are enforced without truncation |
| Local processing | Whisper.cpp, Ollama, and a custom endpoint on loopback | Install local models first. Ollama uses 127.0.0.1:11434 only, excludes remote/cloud entries, and never downloads models automatically |

Default text models: Mistral `mistral-small-latest`, OpenAI `gpt-4.1-mini`, Anthropic `claude-sonnet-4-5`, Gemini `gemini-2.5-flash`. Ollama and the custom endpoint have no default; choose a model.

OpenAI exposes `whisper-1`, `gpt-4o-transcribe`, and `gpt-4o-mini-transcribe`. Only `whisper-1` requests segment timestamps; text-only responses do not generate synthetic timings. AssemblyAI pins `universal-2` rather than accepting a provider-selected model chain. Capability controls describe implemented adapter support, not every capability a provider sells. Provider availability/model access can vary by account.

Whisper.cpp needs `WHISPER_BIN` (default `/opt/homebrew/bin/whisper-cli`) and a multilingual `ggml-base.bin`, `ggml-small.bin`, `ggml-medium.bin`, `ggml-large-v3-turbo.bin`, or `ggml-large-v3.bin` in `WHISPER_MODELS_DIR`. The desktop app sets it to `whisper-models` inside its data folder (macOS: `~/Library/Application Support/com.openplod.vault/whisper-models`); the earlier default `~/clawd/models/whisper` is still checked as a fallback. English-only `.en` model substitution and automatic downloads were removed. Audio conversion uses ffmpeg, with macOS afconvert as a fallback. Local model provisioning/integrity verification is still manual.

Existing Mistral key settings are preserved. Historical documents retain their recorded provider. The old summary-only `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` variables are no longer used; select a supported provider explicitly, or use the restricted custom endpoint below.

## Languages and Timestamps

The speech capability registry (`GET /api/ai-settings`, `capabilities`) carries, per model:

| Provider | Models | Documented languages | Timestamps returned by this adapter |
| --- | --- | --- | --- |
| Whisper.cpp | `base`, `small`, `medium` | Whisper's documented list (57 ISO 639-1 codes) | Segment |
| OpenAI | `whisper-1` | Whisper's documented list | Segment |
| OpenAI | `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | Whisper's documented list | None |
| Mistral Voxtral | `voxtral-mini-latest` | `en`, `es`, `fr`, `pt`, `hi`, `de`, `nl`, `it` | Segment |
| Deepgram | `nova-2`, `nova-3` | Unknown to OpenPlod (`null`) | Word |
| AssemblyAI | `universal-2` | Unknown to OpenPlod (`null`) | Segment with speaker labels on; none without |

A language is refused only when the model has a documented list that excludes it ("does not document support for language …"). When OpenPlod holds no reliable list (`null`), the language is passed through and the provider decides; it is never guessed. Language pickers filter by the list and keep a previously chosen undocumented language visible with a marker rather than dropping it. Transcription profiles are validated the same way.

## Gemini

Gemini (`gemini`) is a text provider for summaries, documents, and chat. Requests go to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with the key in the `x-goog-api-key` header, never in the URL. System instructions are sent as `systemInstruction`, JSON output uses `responseMimeType`, and an answer counts only when `finishReason` is `STOP`; thought parts are excluded from the text. Usage comes from `usageMetadata`. The connection check lists `GET /v1beta/models`. The key is saved as `geminiApiKey` or read from `GEMINI_API_KEY`.

## Custom OpenAI-Compatible Endpoint

The `custom` text provider sends chat requests to `{customBaseUrl}/chat/completions` in the OpenAI chat format. It is deliberately restricted:

- `customBaseUrl` must be HTTPS, or plain HTTP only on loopback (`localhost`, `127.0.0.0/8`, `[::1]`). URLs with credentials, a query string, or a fragment are refused, and redirects are refused.
- A model name is required. The key (`customApiKey`) is optional, sent as `Authorization: Bearer …`, and never read from an environment variable.
- It counts as a **cloud** provider unless the URL is loopback, so local-only mode allows it only on loopback.
- Compatibility is not assumed: JSON mode is not requested, and each feature validates the output itself. The connection check lists `GET {base}/models`.
- Spending for a custom endpoint is always unknown (no price table).

In this build `geminiApiKey` and `customApiKey` are stored without the at-rest encryption applied to the Mistral, Deepgram, OpenAI, AssemblyAI, and Anthropic keys, and they are not removed from unencrypted backups.

## Per-Task Fallback

Fallback is never implied; each list is empty until you configure it.

- **Speech:** `transcriptionFallback` lists up to four speech providers, tried in order if the primary fails. A fallback that cannot honour the requested options is skipped. Each provider is privacy-checked immediately before it is tried. The Transcribe dialog sends no fallback for a per-recording request, automation rules disable it, and a chunked long recording uses the primary provider only.
- **Text:** `analysisFallback`, `documentFallback`, and `chatFallback` each list up to three `{ provider, model }` entries. A fallback that is unconfigured or blocked by local-only mode is skipped, never used. A user-cancelled request never falls back. A request refused because it exceeds a local Ollama model's context only falls back to other local providers, so a long transcript never silently reaches a cloud provider. The Settings UI exposes one fallback per task, limited to cloud providers with default models; the API also accepts Ollama and custom fallbacks with a model.
- **Provenance:** summaries, documents, and chat answers record `{ provider, model, usage, startedAt, completedAt, fallbackFrom }`; `fallbackFrom` lists each provider that failed first, with its error. See the [API reference](api.md#text-provenance-and-fallback).
- The document/chat `expectedProvider` check covers the primary provider only. Configuring a fallback in settings is the consent for sending to it.

## Spending Limits and Prices

OpenPlod estimates cloud cost from a dated table of documented list prices. **Prices are estimates, as of `pricesAsOf` = 2025-08-01.** They are not a bill: discounts, free tiers, add-ons, taxes, minimum charges, and later price changes are not modelled, and no provider is told about or enforces your OpenPlod budget. Check your provider's current pricing and set limits in each provider account too.

| Provider | Model | Price used |
| --- | --- | --- |
| Whisper.cpp, Ollama, loopback custom endpoint | any | $0, runs on this computer (never recorded as spend) |
| Mistral | `voxtral-mini-latest` | $0.001 per audio minute |
| OpenAI | `whisper-1` | $0.006 per audio minute |
| OpenAI | `gpt-4o-transcribe` | $0.006 per audio minute (OpenAI's estimated per-minute cost of token billing) |
| OpenAI | `gpt-4o-mini-transcribe` | $0.003 per audio minute (same caveat) |
| Deepgram | `nova-2`, `nova-3` | Unknown: plan- and add-on-dependent |
| AssemblyAI | `universal-2` | Unknown: tier- and add-on-dependent |
| OpenAI | `gpt-4.1-mini` / `gpt-4.1` / `gpt-4o-mini` | $0.40 / $2 / $0.15 per million input tokens; $1.60 / $8 / $0.60 per million output tokens |
| Anthropic | `claude-sonnet-4-5` / `claude-haiku-4-5` | $3 / $1 input; $15 / $5 output, per million tokens |
| Gemini | `gemini-2.5-flash` | $0.30 input; $2.50 output, per million tokens |
| Mistral | `mistral-small-latest` | Unknown (a moving alias) |
| Any other model, any non-loopback custom endpoint | | Unknown |

An unknown price makes the estimate unknown; it is never guessed. Speech estimates use the recording duration (unknown duration means unknown cost) and include the overlap seconds when audio is split. With speech fallbacks, the estimate uses the most expensive cloud provider in the chain. Text spend is recorded after a request finishes, from the token usage the provider reported.

Two optional settings in Settings > AI providers:

- **Monthly budget** (`monthlyBudgetUsd`): estimated cloud spend per UTC calendar month.
- **Ask above** (`confirmAboveUsd`): a per-job threshold.

When either is set, a transcription needs explicit confirmation if its estimate exceeds the threshold, would take the month over the budget, or cannot be estimated. The Transcribe and Batch dialogs show the estimate and an acceptance checkbox; the API returns `409 cost_confirmation_required` with the estimate until the request is repeated with `confirmCost: true`. The check runs again when the job starts, including automatic transcription after import and rule-queued transcriptions, which cannot confirm and therefore fail with "Nothing was sent". With neither setting configured, nothing extra is asked. The budget is a confirmation threshold, not a cap: confirmed work can exceed it. Text requests (summaries, documents, chat) are recorded in the month-to-date total but are not gated. Settings show month-to-date estimated spend and how many entries had an unknown cost. API details: [Cost confirmation](api.md#cost-confirmation).

## Long Audio

Audio is split only when necessary: when the file exceeds the selected provider's upload limit (OpenAI 25 MB, AssemblyAI 100 MB), or when it is longer than **Split audio longer than** (`transcriptionChunkAboveMinutes`; `0`, the default, means only when a size limit requires it). ffmpeg/ffprobe must be installed.

- Chunks are 600 seconds long. Each chunk except the last runs 2 seconds into the next, so no word is cut without also being heard whole in a neighbour. Chunks are re-encoded to 16 kHz mono 64 kbps MP3 in a temporary folder that is removed afterwards, and sent one at a time to the primary provider only.
- **Overlap rule**, applied in time order: segment times are offset by their chunk's start; then, for every chunk after the first, a segment that starts before the end of the last segment already kept is in the overlap and is dropped. When the provider returned word timings, the segment is trimmed to the words starting at or after that end instead of being dropped whole. Known limitation: without word timings, speech inside a dropped segment that runs past that end is lost, at most one segment per chunk boundary.
- The merged transcript's provenance records `chunking { chunks, chunkSeconds, overlapSeconds, rule: "drop-overlap-before-previous-end" }`. Usage is summed only when every chunk reported it; confidence is averaged only when every chunk had one. Speaker count is unknown for a merged transcript.

Chunking is **refused, and nothing is sent**, when:

- speaker labels are requested (labels are assigned per chunk and cannot be kept consistent);
- the model returns no timestamps (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and AssemblyAI without speaker labels), because the overlap cannot be reconciled without duplicating speech. Together with the previous rule, this means AssemblyAI files over its limit are refused rather than split in this build;
- the file is over the provider's limit and its duration cannot be read.

The error says which case applies. Choose a model with segment timestamps, turn off speaker labels for that recording, or use a provider that accepts the whole file (Mistral, Deepgram, Whisper.cpp have no OpenPlod size limit).

## Retries, Progress, and Cancellation

- **Progress:** chunked jobs report `progress { done, total }` (chunks finished of total) in `/api/v1/jobs` and the legacy `/api/jobs`; the Settings job list shows "chunk n of m". After each finished chunk the result is saved in the job checkpoint, so a restart resumes after the completed chunks; a chunk with a known AssemblyAI remote id resumes polling instead of resubmitting.
- **Automatic retries:** at most two (after 5 s and 30 s), only for errors marked retryable (currently an ffmpeg split failure) and only when the checkpoint shows nothing in flight at a provider and no remote id. A cloud request that may have been sent is never retried automatically, because it may already be billed. `attempts` in the job descriptor counts retries.
- **Restart:** a job interrupted while a cloud request may be in flight is marked failed with an unknown-outcome warning, never resubmitted. A job with a known remote id or nothing in flight is restarted.
- **Cancellation:** cancelling stops local work and polling. For an AssemblyAI job with a known remote id, OpenPlod then sends a best-effort `DELETE /v2/transcript/{id}` (15-second timeout) and appends AssemblyAI's answer to the job error: accepted, refused (HTTP status), or unreachable. Acceptance does not confirm that billing stopped, and the message says so. No deletion is requested in local-only mode or without a saved key; the message says that too. Other providers have no remote cancellation here: a submitted request may still be processed and billed.

## Ollama Context Checks

Ollama runs with a small default context and would silently drop the start of a long transcript. OpenPlod therefore reads the model's context window from Ollama (`POST /api/show`, the `*.context_length` field; shown in Settings after **Load local models**, and available at `GET /api/ai-settings/ollama-context?model=`). Before sending, it estimates the request size at about four bytes per token (an approximation, labelled as such). If the request plus a 256-token margin exceeds the window, it is refused before anything is sent ("This request is about N tokens (approximate), more than the M-token context of …"), and OpenPlod does not switch to a cloud provider. Otherwise it sets `num_ctx` to fit the request and the answer, so Ollama does not truncate. If Ollama does not report a context length, no check is made and `num_ctx` is left to Ollama.

## Prompts, Vocabulary, and Profiles (1.0.0)

Speech models transcribe better when they know what they are hearing. OpenPlod sends that context
only to providers whose API accepts it, through the field each one documents:

| Provider | Context prompt | Vocabulary | Request field |
| --- | --- | --- | --- |
| OpenAI | Yes | Yes | `prompt`: the context, then the vocabulary as a comma-separated line |
| Whisper.cpp | Yes | Yes | `--prompt`: the context, then `Glossary: …` |
| Deepgram | No | Yes | `keywords` on Nova-2, `keyterm` on Nova-3 (one parameter per term) |
| AssemblyAI | No | Yes | `word_boost` |
| Mistral Voxtral | No | No | — |

Write the prompt as a description of the recording ("A weekly product review between the design
and engineering leads; it mentions Voxtral and OpenPlod"), not as instructions: speech models use it
to bias spelling and style, and a prompt in another language than the audio can push the
transcript toward that language. OpenAI's own guidance limits how much of a long prompt
`whisper-1` considers; OpenPlod caps profile prompts at 1,000 characters.

A **transcription profile** stores a prompt, vocabulary, and optionally a provider, model,
language, and speaker-label choice. Settings > Transcription profiles creates them from eight
presets or from scratch; Settings > AI providers picks the default; the Transcribe dialog picks one
per recording and adds a one-off context. Resolution and refusal rules are in the
[API reference](api.md#transcription-profiles). The capability registry exposes the new `prompt`
flag next to `vocabulary` and `diarization`.

## Privacy and Recovery

- Default fallback is empty. A saved fallback list is an explicit additional destination. Per-recording dialog requests use no speech fallback.
- Local-only blocks cloud speech, cloud text AI (including a non-loopback custom endpoint), OpenWhistle forwarding, external webhooks, and task connector exports. Already submitted requests cannot be recalled by changing a setting. Cancel processing separately; provider billing may continue.
- A job stores configuration and source fingerprint, not API keys. Interrupted synchronous cloud calls are failed with an unknown-outcome warning, never automatically resubmitted.
- AssemblyAI stores its remote ID before polling. Resume polls that same ID; it does not upload/submit again. Cancellation stops local polling and requests remote deletion as described above; it does not guarantee remote processing or billing stopped.
- Generated transcript IDs are tied to job IDs. Saving a recovered result twice cannot create duplicate versions. Audio replacement and Trash prevent stale output from becoming current; manual transcript edits remain current.
- Provider HTTP bodies are not included in public errors. Connection checks send no recording audio or transcript text.
- Missing provider usage/cost/confidence is unknown. Cost figures are OpenPlod's estimates from the dated price table above; set limits with your provider as well.

## APIs

- `GET /api/ai-settings`: shared configuration, credential-presence flags, speech capability registry (models, languages, timestamp granularity, size limits), text capabilities, and the price table with `pricesAsOf`.
- `PUT /api/ai-settings`: atomically save validated configuration (including fallbacks, `customBaseUrl`, `monthlyBudgetUsd`, `confirmAboveUsd`, `transcriptionChunkAboveMinutes`) and optional credentials.
- `POST /api/ai-settings/check/:provider`: metadata-only connection check using saved credentials (`mistral`, `openai`, `anthropic`, `gemini`, `custom`, `ollama`, `deepgram`, `assemblyai`).
- `GET /api/ai-settings/ollama-models`: local installed-model inventory, excluding remote models.
- `GET /api/ai-settings/ollama-context?model=`: a local model's context window.
- `GET /api/ai-settings/spending`: month-to-date estimated cloud spend, budget, and threshold.
- `POST /api/ai-settings/estimate`: transcription cost estimate for recordings, with optional `transcription*` overrides.
- `POST /api/recordings/:id/reprocess`: optional transcription configuration overrides for this job (including `transcriptionPrompt` and `transcriptionProfile`) and `confirmCost`; empty body keeps saved defaults. Accepts `Idempotency-Key`.
- `POST /api/v1/jobs`: create a transcription with explicit confirmation, cloud consent, cost confirmation, and `Idempotency-Key`; see the [API reference](api.md#processing-jobs).
- `/api/v1/transcription-profiles`: profile CRUD and presets; see the [API reference](api.md#transcription-profiles).
- `GET /api/jobs`: redacted status, provider, recording ID, phase, remote job ID, and chunk progress.
- `POST /api/jobs/:id/cancel`: stop queued/running local work (and request AssemblyAI remote deletion when applicable).
- `POST /api/jobs/:id/resume`: resume a failed/cancelled job with a known remote job or nothing in flight after the old handler stops.
- `PATCH /api/jobs/:id`: `{ "priority": 5 }`, pending jobs only, -10 through 10.
- Transcript versions include nullable `provenance`; older versions remain unknown.

All routes use the shared API-token middleware. Document/chat requests may include `expectedProvider`; a changed primary provider returns a conflict before transmission. The UI sends it with the disclosed provider. Full request and response shapes: [AI Settings, Spending, and Cost Confirmation](api.md#ai-settings-spending-and-cost-confirmation).

## Validation and Open Gates

Automated tests cover legacy settings, privacy rejection, redaction, multipart framing, upload bounds, unsupported options, malformed timestamps, incomplete output, 401/429/500 handling, cancellation, AssemblyAI checkpoints and remote deletion, remote-ID mismatch, restart recovery, duplicate work, local-model filtering, Gemini and custom-endpoint request shapes, text fallback ordering, Ollama context refusal, the price table and cost gate, the spend ledger, chunk planning, overlap merging, chunk resume, and bounded retries. They use injected fetchers, splitters, and engines.

Not verified: live acceptance of any provider added or changed since 0.5 (OpenAI, AssemblyAI, Anthropic, Gemini, custom endpoints), remote cancellation against the real AssemblyAI service, chunked transcription of real long recordings, Ollama context reporting on real installed models, and the price table against current provider pages. Review `src/ai/pricing.ts` before each release.

Earlier record (0.5, September 8): 122 Bun tests passed (1,076 assertions); backend typecheck and frontend lint/build passed; macOS app and Android ARM64 debug APK builds passed; APK ZIP and native ELF 16 KB alignment passed. Real-vault browser checks passed for playback/waveform pixels, exports, tags, navigation, transcript/chat flows at 320-1440 pixels, and settings persistence/local-only/per-recording controls at 320/390/1440 pixels. Native app launch, physical-phone installation, fresh Plaud extraction, and 16 KB runtime acceptance were not performed in that change.

Remaining work: independent real-provider acceptance; word-level AssemblyAI parsing so long AssemblyAI files can be chunked; a per-transcript context warning inside the document and chat dialogs (the server refusal message is shown instead); full Android runtime tests. Self-service Plaud onboarding and atomic original-sidecar retention also remain roadmap work. No broader Plaud device support was added.

## Official Contracts Consulted

- [OpenAI speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [AssemblyAI submit transcript](https://www.assemblyai.com/docs/api-reference/transcripts/submit)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)
- [Ollama chat](https://docs.ollama.com/api/chat) and [model inventory](https://docs.ollama.com/api/tags)
- [Deepgram prerecorded audio](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded)
