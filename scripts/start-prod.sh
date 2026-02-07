#!/bin/bash
# Start OpenPlaud in production mode
set -e

cd "$(dirname "$0")/.."

# Load env vars
set -a
source ~/clawd/.env 2>/dev/null || true
set +a

export DATABASE_URL=./data/plaud.db
export PLAUD_SYNC_PATH=~/Documents/PlaudSync
export NODE_ENV=production
export PORT=3456

exec bun run src/index.ts
