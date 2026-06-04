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
ARG OPENCLAW_VERSION=2026.6.1
RUN npm install -g openclaw@${OPENCLAW_VERSION} && npm cache clean --force

# Coding CLIs — OpenClaw delegates coding to a backend-agnostic `code-agent`
# wrapper (see bin/code-agent), selected at runtime via CODING_AGENT.
#   claude (default): @anthropic-ai/claude-code  (CLAUDE_CODE_OAUTH_TOKEN | ANTHROPIC_API_KEY)
#   codex           : @openai/codex              (OPENAI_API_KEY / codex login)
# Both are installed so swapping backends is purely a CODING_AGENT env change.
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force
COPY bin/code-agent /usr/local/bin/code-agent
RUN chmod +x /usr/local/bin/code-agent

# GitOps validation tools — so the agent can self-validate manifests BEFORE
# committing to wooogy-hq/infra (helm lint + kubeconform schema + conftest
# policy). Client-side only; no cluster access needed.
RUN set -eux; \
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash; \
    curl -fsSL https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz \
      | tar xz -C /usr/local/bin kubeconform; \
    curl -fsSL https://github.com/open-policy-agent/conftest/releases/download/v0.56.0/conftest_0.56.0_Linux_x86_64.tar.gz \
      | tar xz -C /usr/local/bin conftest

# Non-root user.
RUN groupadd -r oc && useradd -r -g oc -m oc

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm pkg delete scripts.prepare && npm ci --omit=dev && npm cache clean --force
COPY --from=builder /build/dist/ ./dist/

# Default writable locations (override via env). Bind-mount or volume for persistence.
# OPENCLAW_STATE_DIR is OpenClaw's own var: it reads {dir}/openclaw.json and stores
# sessions under {dir}/agents/<id>/sessions. index.ts also injects it into the gateway.
ENV WORKSPACE_DIR=/data/workspace \
    OPENCLAW_STATE_DIR=/state
RUN mkdir -p /data/workspace /state && chown -R oc:oc /data /state /home/oc

# Git auth that survives OpenClaw's sandboxed tool subprocesses (env- AND
# HOME-independent): system-level /etc/gitconfig + an absolute credentials file
# written to /state at runtime (the fine-grained PAT, wooogy-hq scoped).
RUN git config --system credential.helper "store --file=/state/.git-credentials" && \
    git config --system url."https://github.com/".insteadOf "git@github.com:"

USER oc

# Required at runtime (no defaults): DATA_BUCKET, USER_ID, TELEGRAM_BOT_TOKEN,
# AWS creds/region, AI provider key. See .env.example.
ENTRYPOINT ["node", "dist/index.js"]
