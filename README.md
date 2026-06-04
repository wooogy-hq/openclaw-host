# openclaw-host

Standalone, machine-resident **OpenClaw** runtime with **S3 state sync**.

Turn any machine (home server, VPS, spare box) into an always-on OpenClaw agent
host that runs OpenClaw's **native channels** (Telegram, …) and mirrors its
workspace + session state to the **same S3 bucket** used by a
[`serverless-openclaw`](https://github.com/serithemage/serverless-openclaw)
deployment — so state is shared across the machine and the serverless web/Telegram
paths.

> Status: core runtime implemented (config, S3 sync, gateway supervisor,
> lifecycle) with 41 passing tests. Design in [`docs/spec.md`](docs/spec.md).
> Pending: live smoke test on a real machine with a Telegram bot token.

## Quick start (local)

```bash
git clone git@github.com:SeungWookHan/openclaw-host.git
cd openclaw-host
cp .env.example .env   # set DATA_BUCKET, USER_ID, AWS_REGION, TELEGRAM_BOT_TOKEN, AI_PROVIDER...
npm install
npm run build
npm start              # restore from S3 -> write openclaw.json -> run `openclaw gateway run`
```

Requires the `openclaw` CLI on PATH (`npm i -g openclaw@2026.4.26`), or point
`OPENCLAW_BIN` at a specific binary.

## Run as a service ("like an OS")

Recommended: docker compose, so the agent owns a host directory of files/projects
(files scope — full control inside the container, host reach limited to the
mounted workspace; no host services/packages/docker):

```bash
HOST_WORKSPACE=/srv/openclaw docker compose up -d --build
docker compose logs -f
```

See [`docker-compose.yml`](docker-compose.yml) for the mounts and AWS-credential
options. Or run the image directly:

```bash
docker build -t openclaw-host .
docker run -d --restart unless-stopped --env-file .env \
  -v /srv/openclaw:/data/workspace -v openclaw-state:/state openclaw-host
```

or via systemd — see [`deploy/openclaw-host.service`](deploy/openclaw-host.service).

**Scope note:** the agent runs commands *inside the container*. Mounting a host
dir lets it manage those files, but not host services/packages. To let it
administer the host itself, you'd add host access (privileged / `--pid=host` /
docker socket) — deliberately, since that makes the container effectively root
on the box.

## Configuration

All config is via environment variables — see [`.env.example`](.env.example).
Secrets (bot token, AI API key) are delivered via env only and are **never**
written into `openclaw.json`.

## What it is / isn't

- **Is:** OpenClaw process supervisor + S3 workspace/session sync. Native channels
  (Telegram in v1) — OpenClaw talks to chat platforms directly.
- **Isn't:** a serverless stack. No API Gateway, Lambda, DynamoDB, or Bridge.

State is shared with a `serverless-openclaw` deployment through the same S3
bucket: `workspaces/{userId}/...` and `sessions/{userId}/agents/default/sessions/...`.
See [`docs/spec.md`](docs/spec.md) for the full architecture, S3 layout contract,
and boundaries.
