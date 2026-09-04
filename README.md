# OpenPlod

Self-hosted transcription and recording management for [Plaud](https://plaud.ai) devices. No subscription needed — bring your own API keys or use local Whisper.

## Features

- 🎙️ **Auto-sync** — watches your PlaudSync folder for new recordings
- 📝 **Multi-engine transcription** — Whisper (local/free), Groq (fast), Deepgram (diarization)
- 🔍 **Indexed full-text search** across all transcripts
- 🎵 **Range-streamed audio playback** with visual waveform and segment navigation
- 🏷️ **Speaker diarization** (Deepgram engine)
- 📊 **Dashboard** with recording stats and status tracking
- 🌙 **Dark/light mode**
- 🐳 **Docker ready** — one command to run

## Plaud Subscription vs Self-Hosted

| Feature | Plaud Subscription | This App |
|---------|-------------------|----------|
| Monthly cost | $7.90–$16.90/mo | Free (+ optional API costs) |
| Transcription | Cloud only | Local Whisper or cloud |
| Speaker ID | ✓ | ✓ (Deepgram) |
| Search | Basic | Full-text across all transcripts |
| Data privacy | Their servers | Your machine |
| Unlimited recordings | Plan-limited | Unlimited |
| AI Summary | Premium only | Bring your own LLM |

## Quick Start (Docker)

```bash
git clone https://github.com/RemiPelloux/OpenPlod.git
cd OpenPlod

# Optional: set API keys in .env
echo "GROQ_API_KEY=gsk_..." > .env
echo "DEEPGRAM_API_KEY=..." >> .env

docker compose up --build
```

Open [http://localhost:3456](http://localhost:3456)

## Connect a Plaud Note Pro

OpenPlod imports audio files from a local folder. The Plaud Note Pro does not expose recordings through standard Bluetooth file transfer, so use the official Plaud app to export or sync recordings into a folder first. Then set that folder under **Settings > Plaud Sync Folder** and press **Sync**.

On macOS, verify that the Note Pro is awake, nearby, and reachable over Bluetooth Low Energy:

```bash
bun run device:scan
```

This performs a read-only connection probe. It does not download, modify, or delete recordings.

## Manual Setup

Requires [Bun](https://bun.sh) and optionally [whisper-cpp](https://github.com/ggerganov/whisper.cpp).

```bash
# Install dependencies
bun install
cd web && bun install && cd ..

# Build frontend
bun run build

# Set sync folder path
export PLAUD_SYNC_PATH=~/Documents/PlaudSync

# Optional API keys
export GROQ_API_KEY=gsk_...
export DEEPGRAM_API_KEY=...

# Start
bun run start
```

## Development

```bash
# Terminal 1: Backend
bun run dev

# Terminal 2: Frontend (with hot reload + proxy)
bun run dev:web
```

Frontend dev server runs on `:5173` and proxies `/api` to the backend on `:3456`.

Run the quality checks with:

```bash
bun run typecheck
bun test
cd web && bun run lint && bun run build
```

## Transcription Engines

| Engine | Speed | Cost | Diarization | Setup |
|--------|-------|------|-------------|-------|
| **Whisper** (local) | ~1x realtime | Free | No | `brew install whisper-cpp` |
| **Groq** | ~50x realtime | Free tier available | No | API key |
| **Deepgram** | ~10x realtime | Pay-per-use | Yes | API key |

The app automatically falls back through the engine chain: Whisper → Groq → Deepgram.

## Tech Stack

- **Backend:** Bun + Hono + Drizzle ORM + SQLite
- **Frontend:** React + Tailwind CSS + Radix UI
- **Transcription:** whisper.cpp, Groq API, Deepgram API

## Security

Manual installs bind to `127.0.0.1` by default. Docker binds to all interfaces so its published port works; keep it on a trusted network. Add authentication at a reverse proxy before exposing OpenPlod to the internet because recordings and transcripts are private data.

Provider API keys are stored locally and are never returned by the settings API after saving.

## License

MIT
