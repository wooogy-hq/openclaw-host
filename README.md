# openclaw-host

Standalone, machine-resident **OpenClaw** runtime with **S3 state sync**.

Turn any machine (home server, VPS, spare box) into an always-on OpenClaw agent
host that runs OpenClaw's **native channels** (Telegram, …) and mirrors its
workspace + session state to the **same S3 bucket** used by a
[`serverless-openclaw`](https://github.com/serithemage/serverless-openclaw)
deployment — so state is shared across the machine and the serverless web/Telegram
paths.

> Status: early scaffold. Design in [`docs/spec.md`](docs/spec.md). Implementation
> is gated on spec review.

## Quick start (target)

```bash
git clone git@github.com:SeungWookHan/openclaw-host.git
cd openclaw-host
cp .env.example .env   # set DATA_BUCKET, USER_ID, AWS_REGION, TELEGRAM_BOT_TOKEN, AI_PROVIDER...
npm install
npm run build
npm start
```

## What it is / isn't

- **Is:** OpenClaw process supervisor + S3 workspace/session sync. Native channels.
- **Isn't:** a serverless stack. No API Gateway, Lambda, DynamoDB, or Bridge.

See [`docs/spec.md`](docs/spec.md) for architecture, the S3 layout contract, and
boundaries.
