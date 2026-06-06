# Troubleshooting

Operational gotchas for the `openclaw-host` runtime, with root causes and fixes.

---

## What `openclaw.json` is (read this first)

`openclaw.json` is the **runtime config file the OpenClaw gateway reads**, stored at
`${OPENCLAW_STATE_DIR}/openclaw.json` (on the server: `/home/wooogy/openclaw-state/openclaw.json`
→ `/state/openclaw.json` in the container). It holds, as top-level keys:

| Key | Owner | Contents |
|-----|-------|----------|
| `gateway` | host (env) | `port`, `mode`, and `auth` (`{mode:"token", token}`) |
| `channels` | host (env) | Telegram config (token comes from env, never written here) |
| `agents` | host (env) | default model + workspace |
| `mcp` | **runtime** | MCP servers added via `openclaw mcp add` (`mcp.servers.<name>`) |
| `meta` | runtime | OpenClaw bookkeeping (`lastTouchedVersion`, …) |

**The critical fact:** this file is **regenerated on every boot** by `src/index.ts` →
`src/host.ts` → `buildOpenclawConfig()` (env → JSON). It is **not** hand-edited config that
persists by itself.

- **Host-managed keys** (`gateway`, `channels`, `agents`) are authoritative from env/.env —
  edit those by changing `.env` and redeploying, *not* by editing the file.
- **Runtime keys** (`mcp`, `meta`) are added by the gateway/CLI at runtime and are
  **preserved across the rewrite by a shallow merge** (`mergeOpenclawConfig`, added 2026-06-06).

> Before that merge fix, the boot rewrite *overwrote* the file wholesale, silently wiping
> anything added at runtime. That caused the two issues below.

---

## `openclaw cron` fails: "requires credentials" — and why the obvious fix breaks the bot

**Symptom**
```
GatewayCredentialsRequiredError: gateway cron.list requires credentials before opening a websocket
Fix: configure gateway.auth token/password, pair this device, or pass --token/--password.
... unauthorized: gateway token not configured on gateway (set gateway.auth.token)
```

**Root cause**
`openclaw cron` is managed *via the gateway* over an authenticated websocket. The generated
`openclaw.json` has **no `gateway.auth`**, so on each boot the gateway mints a throwaway runtime
token. External clients (the `cron` CLI, cron dispatch) have no matching token → cron is rejected.

**⚠️ The "obvious" fix makes things WORSE — do not use it blindly.**
Setting `gateway.auth = {mode:"token", token}` via `OPENCLAW_GATEWAY_TOKEN` gets `cron list` past
"requires credentials", BUT it flips the gateway into a **device-pairing / scope** model. Local
clients — including the agent runtime that runs **Telegram turns** — then connect with `scopes=0`
and are rejected:
```
pairing required: device is asking for more scopes than currently approved
unauthorized: gateway token mismatch
```
Net effect: **the agent can't run turns → the Telegram bot goes silent.** Granting the local
device operator scope (pairing) is the missing piece and is **currently unsolved here**.

**Status / recommendation**
- The merge fix (next section) is the keeper.
- Leave `OPENCLAW_GATEWAY_TOKEN` **unset** (default) so the bot works. Cron stays unavailable
  until the scope/pairing piece is figured out (`openclaw pairing` / `approvals` / `devices`).
- The env plumbing exists (`buildOpenclawConfig` writes `gateway.auth` when the var is set) but
  setting it is a known footgun — see the next section for the failure mode it triggers.

---

## Telegram bot goes silent / gateway restart loop (agent self-fix loop)

**Symptom**
The bot stops replying. Logs show, every ~30s, `[gateway] signal SIGTERM received` /
`gateway-tool: restart requested` and/or `[tools] cron failed: ... token mismatch`; the gateway
keeps re-"ready"-ing. The agent may send "I was interrupted by a gateway restart, resend that."

**Root cause**
The agent has shell `exec` and broad autonomy. When it hit the cron/gateway-auth problem it tried
to **self-fix** by writing a destructive plan into its **main session** — including
`kill <gateway-pid>` to force a restart. On every restart the main session resumes and re-runs the
plan → an infinite kill/restart loop that takes the Telegram channel down with it. (The Telegram
DM uses a *separate* session and is fine; it just can't work while the gateway is being killed.)

**Fix — quarantine the rogue main session (non-destructive)**
```bash
docker stop openclaw-host
SES=/home/wooogy/openclaw-state/agents/main/sessions
cp $SES/sessions.json $SES/sessions.json.bak
# 1) the rogue id is sessions.json -> "agent:main:main".sessionId
# 2) move its transcripts aside (recoverable):
mkdir -p $SES/_quarantine && mv $SES/<sessionId>.* $SES/_quarantine/
# 3) drop the agent:main:main pointer so a FRESH main session starts (keep telegram + cron):
docker run --rm -v /home/wooogy/openclaw-state:/state node:22-slim \
  node -e 'const f="/state/agents/main/sessions/sessions.json";const fs=require("fs");const d=JSON.parse(fs.readFileSync(f));delete d["agent:main:main"];fs.writeFileSync(f,JSON.stringify(d,null,2))'
docker start openclaw-host
```
**Verify:** `docker logs --since 60s openclaw-host | grep -cE "kill |SIGTERM received|token mismatch"` → 0; `RestartCount` stays put.

**Prevention:** don't ask the agent to fix gateway/cron auth itself, and don't set
`OPENCLAW_GATEWAY_TOKEN` (previous section) — both can send it into this loop.

---

## Gateway auth models: "local" (current) vs token / device-pairing

The gateway supports several auth modes (`openclaw gateway --auth none|token|password|trusted-proxy`).
Two matter here, and the difference is exactly why setting a token kills the bot:

### Current — `gateway.mode:"local"`, no `gateway.auth` (permissive local-trust)
- **In-process work is trusted.** The Telegram channel runs *inside* the gateway process, so the
  agent turns it triggers do **not** open an external authenticated websocket — they just run.
- **External CLI clients** (`openclaw cron`, `openclaw agent`, `openclaw status`, …) connect over
  the websocket and are **not** trusted → `requires credentials before opening a websocket`.
- Net: the **bot works with zero setup**, but you can't drive the gateway from the CLI (no cron).

### Token / device-pairing — `gateway.auth:{mode:"token", token}`
- **Every** connection must present the token *and* be a **paired device with an approved role**
  (operator). Identity is per-device, not "is it loopback?".
- External clients now connect (with the token) → **cron CLI works**.
- BUT the agent runtime's own connection arrives as `device=no, scopes=0` and is **rejected**:
  `pairing required: device is asking for more scopes than currently approved`. Until that device
  is paired as operator (`openclaw devices approve` / `rotate`), the agent can't run turns → **the
  Telegram bot goes silent.**

| | local (current) | token / device-pairing |
|---|---|---|
| Telegram bot (in-process turns) | ✅ works | ❌ until the agent device is paired as operator |
| `openclaw cron` / CLI (external) | ❌ "requires credentials" | ✅ with token (+ pairing for writes) |
| Setup | none | generate token **and** pair the agent device |
| Security model | trusts all loopback | per-device identity + roles |

**The trap:** the token doesn't just *add* auth for the CLI — it also makes the gateway demand a
paired-operator identity from the agent runtime, which it doesn't have by default. So a naive
"set the token to fix cron" locks out the bot's own turns. The correct migration is to set the
token **and** pair the agent device as operator together (via `openclaw devices`) — not yet
worked out in this repo. Until then: stay on local (no token); the bot works, cron doesn't.

---

## Telegram bot receives nothing (no log activity on a message)

**Symptom**
You message `@<bot>` and get no reply, and `docker logs openclaw-host` shows **no activity at all**
when the message is sent (not even an error). The telegram session transcript
(`/state/agents/main/sessions/...telegram...`) stops updating. `getUpdates` returns `[]`,
`getWebhookInfo` shows no webhook, and there is no `409 Conflict` in the logs.

**Most likely cause — a second consumer is stealing the updates.**
A Telegram bot token can only be polled by **one** consumer at a time: whichever `getUpdates`
caller confirms an offset *removes* those updates for everyone else. If another deployment runs
the **same `TELEGRAM_BOT_TOKEN`** (e.g. the `serverless-openclaw` stack this repo shares S3 state
with — see README), it grabs and confirms each update, so this host's poller sees nothing. No
`409` appears because they aren't long-polling at the exact same instant — they just race per call.

**Diagnose**
```bash
# After sending a fresh message, peek WITHOUT consuming (briefly stop this poller first for a clean read):
docker exec openclaw-host sh -lc 'T=$(tr "\0" "\n"</proc/1/environ|grep ^TELEGRAM_BOT_TOKEN=|cut -d= -f2); curl -s "https://api.telegram.org/bot$T/getUpdates?offset=-1&timeout=0"'
# message present here but nothing in `docker logs` -> this host isn't fetching (polling broken)
# empty right after you sent -> another consumer already took it (the shared-token case)
```

**Fix**
- Ensure **only one** deployment polls the bot token. Stop the other (serverless) poller, or give
  this host its **own** bot token.
- Other (less common) causes: a webhook set on the token (`deleteWebhook` to clear), or a stuck
  ingress offset (the `update-offset-default.json` was archived to `*.migrated`).

---

## A configured MCP server disappears after a restart

**Symptom**
`openclaw mcp add …` succeeds ("Saved MCP server … to /state/openclaw.json") and works, but
after a container restart/redeploy `openclaw mcp list` is empty and the agent loses the tools.

**Root cause**
Same as above: the per-boot rewrite of `openclaw.json` overwrote the file and dropped the
top-level `mcp` key.

**Fix**
`writeConfigFile` now **merges** the freshly generated config over the existing file
(`mergeOpenclawConfig`), preserving runtime-added top-level keys like `mcp` and `meta` while
keeping host-managed keys authoritative. No action needed beyond running the fixed image
(2026-06-06+). Re-add the server once if it was lost:
```bash
docker exec openclaw-host openclaw mcp add risk-radar \
  --transport streamable-http --url http://risk-radar-mcp:8765/mcp
docker exec openclaw-host openclaw mcp reload
```

**Verify it now persists**
```bash
docker restart openclaw-host && sleep 12
docker exec openclaw-host node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync("/state/openclaw.json")).mcp?.servers||{}))'
# -> [ 'risk-radar' ]
```

---

## MCP server (sidecar) unreachable from the agent

**Symptom**
`openclaw mcp probe <name>` fails to connect; `curl http://<name>:8765/mcp` from inside
`openclaw-host` can't resolve the name.

**Root cause / fix**
Self-hosted sidecar MCP containers must share the `oc-net` docker network with `openclaw-host`,
and the MCP must bind `0.0.0.0` (not `127.0.0.1`). `run.sh` creates `oc-net` and attaches
openclaw-host; run the sidecar with the generic `run-mcp-sidecar.sh` on `oc-net` (binding
`0.0.0.0`). A reachable endpoint answers `HTTP 406` to a bare `GET /mcp` (MCP needs proper
headers) — 406 means it's alive, not broken. See the README "MCP servers" section and
`examples/mcp-sidecars/`.

---

## Redeploy lost the agent's state / sessions

**Cause**
Running `docker compose up` with the *old* compose (named volumes) instead of `run.sh` (host
bind mounts) created a fresh empty `/state`. Both `run.sh` and `docker-compose.yml` now use the
same host bind mounts (`/home/wooogy/openclaw-{workspace,state,skills}`), so either tool attaches
to the same state. Never point `/state` at a fresh named volume. See README "Run as a service".

---

## General rule

Anything you want to change **permanently** about `gateway` / `channels` / `agents` goes in
**`.env` + redeploy** — editing `openclaw.json` directly won't survive the next boot. Runtime
state added through the gateway (`mcp`, cron jobs, `meta`) persists on its own (cron lives in
`/state/tasks/`, MCP in `openclaw.json` via the merge).
