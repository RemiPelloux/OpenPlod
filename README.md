# Plaud App

> **🌐 Live:** [https://yield-portion-employers-kirk.trycloudflare.com](https://yield-portion-employers-kirk.trycloudflare.com)

Self-hosted transcription and recording management for [Plaud](https://plaud.ai) devices. No subscription needed — bring your own API keys or use local Whisper.

![Dashboard](screenshots/dashboard.png)

## Features

- 🎙️ **Auto-sync** — watches your PlaudSync folder for new recordings
- 📝 **Multi-engine transcription** — Whisper (local/free), Groq (fast), Deepgram (diarization)
- 🔍 **Full-text search** across all transcripts
- 🎵 **Audio playback** with visual waveform and segment navigation
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
git clone https://github.com/yourusername/plaud-app.git
cd plaud-app

# Optional: set API keys in .env
echo "GROQ_API_KEY=gsk_..." > .env
echo "DEEPGRAM_API_KEY=..." >> .env

docker compose up --build
```

Open [http://localhost:3456](http://localhost:3456)

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

## License

MIT
