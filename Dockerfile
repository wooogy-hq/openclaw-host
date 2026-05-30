# openclaw-host — standalone OpenClaw runtime with S3 state sync.
# Stage 1: build TypeScript
FROM node:22-slim AS builder
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm pkg delete scripts.prepare && npm ci
COPY src/ src/
RUN npm run build

# Stage 2: runtime
FROM node:22-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git && \
    rm -rf /var/lib/apt/lists/*

# OpenClaw CLI on PATH (pinned to match the serverless deployment's session format).
ARG OPENCLAW_VERSION=2026.4.26
RUN npm install -g openclaw@${OPENCLAW_VERSION} && npm cache clean --force

# Non-root user.
RUN groupadd -r oc && useradd -r -g oc -m oc

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm pkg delete scripts.prepare && npm ci --omit=dev && npm cache clean --force
COPY --from=builder /build/dist/ ./dist/

# Default writable locations (override via env). Bind-mount or volume for persistence.
ENV WORKSPACE_DIR=/data/workspace \
    OPENCLAW_HOME=/home/oc/.openclaw
RUN mkdir -p /data/workspace && chown -R oc:oc /data /home/oc
USER oc

# Required at runtime (no defaults): DATA_BUCKET, USER_ID, TELEGRAM_BOT_TOKEN,
# AWS creds/region, AI provider key. See .env.example.
ENTRYPOINT ["node", "dist/index.js"]
