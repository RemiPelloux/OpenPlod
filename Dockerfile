# Stage 1: Install dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile

# Stage 2: Build frontend
FROM oven/bun:1 AS build-web
WORKDIR /app/web
COPY --from=deps /app/web/node_modules ./node_modules
COPY web/ ./
RUN bun run build

# Stage 3: Runtime
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Install ffmpeg for audio conversion
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY tsconfig.json ./
COPY --from=build-web /app/web/dist ./web/dist

# Create data directory
RUN mkdir -p /app/data /plaud

ENV PORT=3456
ENV DATABASE_URL=/app/data/plaud.db
ENV PLAUD_SYNC_PATH=/plaud

EXPOSE 3456

VOLUME ["/app/data", "/plaud"]

CMD ["bun", "run", "src/index.ts"]
