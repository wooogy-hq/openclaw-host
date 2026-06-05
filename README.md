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

The agent owns host directories of files/projects (files scope — full control
inside the container, host reach limited to the mounted dirs; no host
services/packages/docker). Two equivalent paths:

**`run.sh` — the primary deploy on the home server.** Builds the image and
(re)runs the container with bind-mounted workspace/state/skills:

```bash
bash run.sh                 # docker build + graceful stop -t 150 + docker run
docker logs -f openclaw-host
```

**docker compose — the declarative equivalent of `run.sh`** (same container
name, bind paths, env, and uid), so either tool attaches to the *same* state
without loss:

```bash
docker compose up -d --build      # override paths via HOST_WORKSPACE / HOST_STATE / HOST_SKILLS
docker compose logs -f
```

See [`run.sh`](run.sh) / [`docker-compose.yml`](docker-compose.yml) for the exact
mounts (`/data/workspace`, `/state`, `/skills`), `HOME=/state`, and AWS-credential
options, or run via systemd — see [`deploy/openclaw-host.service`](deploy/openclaw-host.service).

**Scope note:** the agent runs commands *inside the container*. Mounting a host
dir lets it manage those files, but not host services/packages. To let it
administer the host itself, you'd add host access (privileged / `--pid=host` /
docker socket) — deliberately, since that makes the container effectively root
on the box.

## Configuration

All config is via environment variables — see [`.env.example`](.env.example).
Secrets (bot token, AI API key) are delivered via env only and are **never**
written into `openclaw.json`.

## Skills (runtime install, no redeploy)

The coding delegate runs Claude Code headless (`claude -p`), where the interactive
`/plugin install` REPL doesn't exist. Instead, skill **plugins** are loaded from
disk via `--plugin-dir`:

- **Baked-in default:** [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills)
  is cloned into `/opt/agent-skills` at build time, giving the agent
  `/spec /plan /build /test /review /ship`. Pin a version with the
  `AGENT_SKILLS_REF` build arg.
- **Runtime, agent-installed:** the agent (or you) can add more plugins **without a
  rebuild or redeploy** using the `install-skill` helper. Plugins land in the
  persisted `/skills` volume (`openclaw-skills`) and survive restarts; `code-agent`
  auto-loads every plugin found there on each run.

```bash
install-skill add <owner/repo> [name]   # git-clone a plugin repo into /skills
install-skill list                       # list installed plugins
install-skill update [name]              # git pull (all, or one)
install-skill remove <name>
```

A plugin repo must contain `.claude-plugin/plugin.json`. The agent learns this
workflow from its workspace `AGENTS.md` / `TOOLS.md`. Disable plugin loading with
`CODE_AGENT_NO_PLUGINS=1`, or force a single dir with `CLAUDE_PLUGIN_DIR`.

## Architecture

```mermaid
flowchart TD
    User([User]) -->|message| TG[Telegram]
    TG -->|webhook / polling| OC[OpenClaw\nDeepSeek v4 Pro]

    OC -->|coding task| CA[code-agent\nClaude Code --print]
    OC -->|knowledge query| KBQ[kb-query skill]

    KBQ -->|shell exec| KB[kb CLI\n~/.local/bin/kb]
    KB -->|LLM inference| DS[DeepSeek API]
    KB <-->|read concepts| KBV[(kb-vault\nwooogy-hq/kb-vault\n56 concepts)]

    CA -->|code + diffs| OC
    DS -->|answer| KB
    KB -->|answer| KBQ
    KBQ -->|context| OC

    OC -->|reply| TG
    TG -->|reply| User

    WS[Workspace docs\n*.md, specs, ADRs] -->|kb compile| KB
    KB -->|kb push| KBV
```

## Knowledge Base Integration

The agent uses [`kb`](https://github.com/wooogy-hq/kb-vault) — a local CLI
knowledge-base tool — to answer questions from a curated vault of 56 concepts
maintained in [`wooogy-hq/kb-vault`](https://github.com/wooogy-hq/kb-vault).

**Components**

| Component | Role |
|---|---|
| `kb` binary (`~/.local/bin/kb`) | CLI that reads the vault and queries DeepSeek for LLM-assisted lookups |
| `kb-vault` (GitHub) | Version-controlled set of Markdown concept files; the source of truth |
| `kb-query` OpenClaw skill | Exposes `kb` to the running agent so it can call it mid-conversation |
| DeepSeek API | LLM backend used by `kb` for semantic search and synthesis |

**How it works**

1. The agent receives a question that needs domain context (architecture decisions,
   project conventions, known patterns).
2. It calls the `kb-query` skill, which shells out to `kb query <question>`.
3. `kb` looks up relevant concepts from the local clone of `kb-vault` and, if
   needed, sends them plus the question to DeepSeek to synthesize an answer.
4. The answer is returned to the agent as context before it composes its reply.

**Keeping the vault up to date**

Workspace documentation (specs, ADRs, how-tos) is compiled into the vault:

```bash
kb compile docs/          # parse workspace Markdown into concept files
kb push                   # push updated concepts to wooogy-hq/kb-vault on GitHub
```

This keeps the agent's knowledge current with the project without bloating the
system prompt.

## What it is / isn't

- **Is:** OpenClaw process supervisor + S3 workspace/session sync. Native channels
  (Telegram in v1) — OpenClaw talks to chat platforms directly.
- **Isn't:** a serverless stack. No API Gateway, Lambda, DynamoDB, or Bridge.

State is shared with a `serverless-openclaw` deployment through the same S3
bucket: `workspaces/{userId}/...` and `sessions/{userId}/agents/default/sessions/...`.
See [`docs/spec.md`](docs/spec.md) for the full architecture, S3 layout contract,
and boundaries.
