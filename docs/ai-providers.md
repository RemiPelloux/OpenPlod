# AI Providers: 0.5.0 Implementation Status

Version 0.5.0 is an experimental prerelease, not a production-accepted milestone. No new live-provider success is claimed. The public package is macOS Apple Silicon only; the Android debug build remains a local development artifact.

## Setup

Open Settings > AI providers. Speech-to-text receives audio; summaries, documents, and chat receive text. Set each task's provider/model separately and press Save AI. API keys remain server-side; GET settings exposes only configured flags. Blank untouched fields preserve saved keys. The API accepts an explicit empty credential to clear a saved value; environment credentials remain a fallback.

| Task | Implemented adapters | Important limits |
| --- | --- | --- |
| Transcription | Mistral Voxtral, Whisper.cpp, Deepgram, OpenAI, AssemblyAI | OpenAI rejects files over 25 MB; AssemblyAI is capped at 100 MB by OpenPlod. No automatic splitting. |
| Summaries, documents, cited chat | Mistral, OpenAI, Anthropic, Ollama | Complete structured results required. No fabricated fallback response. Input-size bounds remain enforced without truncation. |
| Local processing | Whisper.cpp and Ollama | Install local models first. Ollama uses 127.0.0.1:11434 only, excludes remote/cloud entries, and never downloads models automatically. |

OpenAI exposes `whisper-1`, `gpt-4o-transcribe`, and `gpt-4o-mini-transcribe`. Only `whisper-1` requests segment timestamps; text-only responses do not generate synthetic timings. AssemblyAI pins `universal-2` rather than accepting a provider-selected model chain. Capability controls describe implemented adapter support, not every capability a provider sells. Provider availability/model access can vary by account.

Whisper.cpp needs `WHISPER_BIN` (default `/opt/homebrew/bin/whisper-cli`) and a multilingual `ggml-base.bin`, `ggml-small.bin`, or `ggml-medium.bin` in `WHISPER_MODELS_DIR` (default `~/clawd/models/whisper`). English-only `.en` model substitution and automatic downloads were removed. Audio conversion uses ffmpeg, with macOS afconvert as a fallback. Local model provisioning/integrity verification is still manual.

Existing Mistral key settings are preserved. Historical documents retain their recorded provider. The old summary-only `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` variables are no longer used; select a supported analysis provider explicitly. Arbitrary custom endpoints are deferred.

## Privacy and Recovery

- Default fallback is empty. A saved fallback list is an explicit additional audio destination. Per-recording dialog requests use no fallback.
- Local-only blocks cloud speech, text AI, and OpenWhistle forwarding. Already submitted requests cannot be recalled by changing a setting. Cancel processing separately; provider billing may continue.
- A job stores configuration and source fingerprint, not API keys. Interrupted synchronous cloud calls are failed with an unknown-outcome warning, never automatically resubmitted.
- AssemblyAI stores its remote ID before polling. Resume polls that same ID; it does not upload/submit again. Cancellation stops local polling, not guaranteed remote processing or billing.
- Generated transcript IDs are tied to job IDs. Saving a recovered result twice cannot create duplicate versions. Audio replacement and Trash prevent stale output from becoming current; manual transcript edits remain current.
- Provider HTTP bodies are not included in public errors. Connection checks send no recording audio or transcript text.
- Missing provider usage/cost/confidence is unknown. No spend cap or price estimate is implemented yet. Set limits with your provider before using paid processing.

## APIs

- `GET /api/ai-settings`: shared configuration, credential-presence flags, speech capability registry.
- `PUT /api/ai-settings`: atomically save validated configuration and optional credentials.
- `POST /api/ai-settings/check/:provider`: metadata-only connection check using saved credentials.
- `GET /api/ai-settings/ollama-models`: local installed-model inventory, excluding remote models.
- `POST /api/recordings/:id/reprocess`: optional transcription configuration overrides for this job; empty body keeps saved defaults.
- `GET /api/jobs`: redacted status, provider, recording ID, phase and remote job ID.
- `POST /api/jobs/:id/cancel`: stop queued/running local work.
- `POST /api/jobs/:id/resume`: resume a failed/cancelled known remote job after the old handler stops.
- `PATCH /api/jobs/:id`: `{ "priority": 5 }`, pending jobs only, -10 through 10.
- Transcript versions include nullable `provenance`; older versions remain unknown.

All routes use existing API-token middleware. Document/chat requests may include `expectedProvider`; a changed provider returns a conflict before transmission. The new UI sends it with the disclosed provider.

## Validation and Open Gates

Automated tests cover legacy settings, privacy rejection, redaction, multipart framing, upload bounds, unsupported options, malformed timestamps, incomplete output, 401/429/500 handling, cancellation, AssemblyAI checkpoints, remote-ID mismatch, restart recovery, duplicate work, and local-model filtering. Existing Markdown/citation tests still pass with the shared text adapter.

The development Mac has a Mistral key but no configured OpenAI, AssemblyAI, or Anthropic credential; Ollama is not running. New-provider real-audio/text acceptance is therefore pending. UI tests use a private snapshot containing two real saved transcripts, never fabricated product data.

September 8 checks: 122 Bun tests passed (1,076 assertions); backend typecheck and frontend lint/build passed; macOS app and Android ARM64 debug APK builds passed; APK ZIP and native ELF 16 KB alignment passed. Real-vault browser checks passed for playback/waveform pixels, exports, tags, navigation, transcript/chat flows at 320-1440 pixels, and settings persistence/local-only/per-recording controls at 320/390/1440 pixels. The Browser plugin was unavailable, so existing Playwright checks were used. Native app launch, physical-phone installation, fresh Plaud extraction, and 16 KB runtime acceptance were not performed in this change.

Remaining 0.5 work: cloud spending controls (AI-10); automatic large-file chunking; complete per-model languages/timestamp granularity catalogs; complete analysis/document usage history; independent real-provider acceptance; full Android runtime tests. Self-service Plaud onboarding and atomic original-sidecar retention also remain roadmap work. No broader Plaud device support was added.

## Official Contracts Consulted

- [OpenAI speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [AssemblyAI submit transcript](https://www.assemblyai.com/docs/api-reference/transcripts/submit)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Ollama chat](https://docs.ollama.com/api/chat) and [model inventory](https://docs.ollama.com/api/tags)
- [Deepgram prerecorded audio](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded)
