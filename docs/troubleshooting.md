# Troubleshooting

Operational gotchas for the `openclaw-host` runtime, with root causes and fixes.

---

## ⭐ Telegram bot stops replying — THE root cause (OpenClaw 2026.6.1 regression)

**This is the big one** (2026-06-06). If the bot won't reply to your DMs, it is almost
certainly the OpenClaw version, **not** your config.

**Symptom**
- You DM `@<bot>` and get **no reply**. Outbound still works (the agent can send proactively,
  cron/heartbeat deliveries arrive), and `openclaw channels status --probe` says telegram
  `connected, mode:polling, works`. But inbound DMs never produce a turn.
- The Telegram session transcript never updates; no error is logged.

**Root cause — OpenClaw 2026.6.1 Telegram ingress regression** ([openclaw/openclaw#86957](https://github.com/openclaw/openclaw/issues/86957)).
In 2026.6.1 the Telegram **"isolated polling ingress"** fetches inbound messages but **fails to
route them from the ingress spool to the agent session**. On this host it was even worse: the
spool directory was never created, and the version-2 offset file
(`/state/telegram/update-offset-default.json`) got re-archived to `.migrated` on every run. Net
result: messages are pulled off Telegram and silently dropped.

Tells that you're hitting it (on 2026.6.1):
- `[telegram] [diag] isolated polling ingress started` is the **last** telegram log line —
  no fetch/route lines follow, even with `OPENCLAW_DEBUG_TELEGRAM_INGRESS=1`.
- `/state/telegram/ingress-spool-default/` is missing or empty.
- the gateway loads only **2 plugins** (`memory-core, telegram`) instead of the full 8.

**Fix — pin OpenClaw to `2026.5.28`** (done in the Dockerfile; `ARG OPENCLAW_VERSION`).
2026.5.28's ingress works correctly: on boot it logs
`Detected legacy update offset … discarding stale update offset … starting fresh`, loads all
**8 plugins**, and routes inbound DMs end-to-end:
```
[telegram] Inbound message telegram:<id> -> @<bot> (direct, N chars)
[diagnostic] session turn created … sessionKey=agent:main:main trigger=user
[telegram] outbound send ok … operation=sendMessage
```
Do **not** bump back to 2026.6.1 until #86957 is fixed upstream. (Downgrade note: a CLI run may
warn `config was written by version 2026.6.1, but this command is running 2026.5.28` — harmless;
`meta.lastTouchedVersion` just lags until rewritten.)

> Misdiagnoses we ruled out (so you don't repeat them): it is **not** DM pairing
> (`openclaw pairing list --channel telegram` → no pending, no "drop dm (pairing required)"),
> **not** a 401/429 API error, **not** a second consumer stealing `getUpdates` (only one
> `Conflict` ever appeared and it was our own diagnostic `curl`), and **not** the gateway token.

---

## What `openclaw.json` is (read this before touching config)

`openclaw.json` is the **runtime config the gateway reads**, at `${OPENCLAW_STATE_DIR}/openclaw.json`
(server: `/home/wooogy/openclaw-state/openclaw.json` → `/state/openclaw.json` in the container):

| Key | Owner | Contents |
|-----|-------|----------|
| `gateway` | host (env) | `port`, `mode`, `auth` (`{mode:"token", token}` from `OPENCLAW_GATEWAY_TOKEN`) |
| `channels` | host (env) | Telegram config (bot token via env, never written here) |
| `agents` | host (env) | default model + workspace |
| `mcp` | **runtime** | MCP servers from `openclaw mcp add` (`mcp.servers.<name>`) |
| `meta` | runtime | OpenClaw bookkeeping (`lastTouchedVersion`, …) |

**Critical fact:** this file is **regenerated on every boot** by `src/index.ts` → `src/host.ts` →
`buildOpenclawConfig()` (env → JSON). Host-managed keys (`gateway`/`channels`/`agents`) are
authoritative from `.env` — change them via `.env` + redeploy, not by hand-editing the file.
Runtime keys (`mcp`, `meta`) are **preserved across the rewrite by a shallow merge**
(`mergeOpenclawConfig`). Before that merge fix, the rewrite wiped them (see "MCP disappears").

---

## `openclaw cron` requires a gateway token — and that token is REQUIRED, not a footgun

> Correction: earlier notes here claimed setting `OPENCLAW_GATEWAY_TOKEN` "breaks the bot." That
> was wrong — it was a side effect of corrupted device state during repeated auth churn, plus the
> 2026.6.1 regression above. On a clean 2026.5.28 setup the token is set and **everything works**
> (cron, `openclaw agent`, and the Telegram bot).

**Why a token is needed.** `openclaw cron`, `openclaw agent`, and the Telegram **isolated ingress**
all reach the gateway over an **authenticated websocket**. With no `gateway.auth`, the gateway
mints a throwaway per-boot token and those clients fail with
`requires credentials before opening a websocket`.

**Setup:** put a stable token in `.env` (`OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)`).
`buildOpenclawConfig` writes `gateway.auth={mode:"token",token}` and the local device auto-pairs
as `operator` on first connect.

**If you see `device token scope mismatch` / `pairing required: asking for more scopes than
approved`** (happens after toggling the token on/off repeatedly — the device pairing under
`/state/devices` gets stuck at `operator.read` with a pending `operator.admin`): clear the stale
pairing and let it re-pair clean (keep the identity keypair):
```bash
docker stop openclaw-host
ST=/home/wooogy/openclaw-state
cp -r $ST/devices $ST/_devbak; \
rm -f $ST/devices/paired.json $ST/devices/pending.json $ST/identity/device-auth.json   # keep identity/device.json
docker start openclaw-host
docker exec openclaw-host openclaw agent --agent main -m "reply READY"   # should print READY
```

---

## Telegram bot goes silent + gateway restart loop (agent self-fix loop)

**Symptom**
The bot stops replying and logs show, every ~30s, `[gateway] signal SIGTERM received` /
`gateway-tool: restart requested` and/or `[tools] cron failed: ... token mismatch`; the gateway
keeps re-"ready"-ing. The agent may say "I was interrupted by a gateway restart, resend that."

**Root cause**
The agent has shell `exec` and broad autonomy. Hitting a gateway/cron auth problem, it tried to
**self-fix** by writing a destructive plan into its **main session** — including
`kill <gateway-pid>` to force a restart. Every restart resumes that session and re-runs the plan →
an infinite kill/restart loop that takes the Telegram channel down with it.

**Fix — quarantine the rogue main session (non-destructive)**
```bash
docker stop openclaw-host
SES=/home/wooogy/openclaw-state/agents/main/sessions
cp $SES/sessions.json $SES/sessions.json.bak
# rogue id = sessions.json -> "agent:main:main".sessionId ; move its transcripts aside:
mkdir -p $SES/_quarantine && mv $SES/<sessionId>.* $SES/_quarantine/
# drop the agent:main:main pointer so a FRESH main session starts (keep telegram + cron entries):
docker run --rm -v /home/wooogy/openclaw-state:/state node:22-slim \
  node -e 'const f="/state/agents/main/sessions/sessions.json";const fs=require("fs");const d=JSON.parse(fs.readFileSync(f));delete d["agent:main:main"];fs.writeFileSync(f,JSON.stringify(d,null,2))'
docker start openclaw-host
```
**Verify:** `docker logs --since 60s openclaw-host | grep -cE "kill |SIGTERM received|token mismatch"` → 0.

**Prevention:** don't ask the autonomous agent to fix gateway/cron auth itself.

---

## A configured MCP server disappears after a restart

**Symptom** `openclaw mcp add …` works, but after a restart `openclaw mcp list` is empty.

**Root cause** the per-boot rewrite of `openclaw.json` used to overwrite the file wholesale,
dropping the top-level `mcp` key.

**Fix** `writeConfigFile` now **merges** the generated config over the existing file
(`mergeOpenclawConfig`), preserving `mcp`/`meta` while keeping host keys authoritative. Re-add once
if it was lost, then it persists:
```bash
docker exec openclaw-host openclaw mcp add risk-radar --transport streamable-http --url http://risk-radar-mcp:8765/mcp
docker exec openclaw-host openclaw mcp reload
docker restart openclaw-host && sleep 12
docker exec openclaw-host node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync("/state/openclaw.json")).mcp?.servers||{}))'  # -> [ 'risk-radar' ]
```

---

## MCP sidecar unreachable from the agent

Self-hosted sidecar MCP containers must share the `oc-net` docker network with `openclaw-host`,
and the MCP must bind `0.0.0.0` (not `127.0.0.1`). `run.sh` creates `oc-net` and attaches
openclaw-host; run the sidecar with `run-mcp-sidecar.sh`. A reachable `/mcp` endpoint answers
`HTTP 406` to a bare `GET` — that means alive, not broken. See README "MCP servers" and
`examples/mcp-sidecars/`.

---

## Redeploy lost the agent's state / sessions

Running `docker compose up` with the *old* compose (named volumes) instead of `run.sh` (host bind
mounts) created a fresh empty `/state`. Both `run.sh` and `docker-compose.yml` now use the same
host bind mounts (`/home/wooogy/openclaw-{workspace,state,skills}`), so either tool attaches to the
same state. Never point `/state` at a fresh named volume.

## A second agent ignores its channel binding

`openclaw agents bind --agent work --bind discord` writes the route into `openclaw.json`'s
top-level `bindings` key and prints it back happily, but the running gateway read that file at
boot. Until you restart, every message keeps going to the default agent — and the symptom is
confusing, because `openclaw agents bindings` shows the binding you expect.

Check which agent actually handled a message by watching which session dir grows:

```
for a in main work; do ls -lt /state/agents/$a/sessions/*.jsonl | head -1; done
```

A new session file under the *intended* agent (and a `sessionKey` like
`agent:work:discord:channel:<id>`) is the proof. `bindings` survives redeploys — `run.sh` only
overwrites `gateway`/`channels`/`agents`.

## A new agent's workspace fails with EACCES

`openclaw agents add work --workspace /data/workspace-work` fails with
`EACCES: permission denied, mkdir`. `/data` is root-owned inside the container and the gateway runs
as uid 1000. Add a host bind mount in `run.sh` first — which you want regardless, or the workspace
lives in the image layer and disappears on the next rebuild.

## The agent gets 404 on a private org repo

A fine-grained PAT only sees an organisation that either owns the token or has approved it. A token
issued under your personal account returns **404** (not 403) for org repos — the repo is invisible,
not forbidden. Issue a new one with **Resource owner = the org**.

Tokens are then routed per path by `/state/bin/git-credential-oc`, which git reaches through
`credential.https://github.com.helper` in `/state/.gitconfig` (with `usehttppath=true`, so git
passes `path=<org>/<repo>.git`):

```
the-form/*   -> /state/.gh-token-theform
saedungji/*  -> /state/.gh-token-saju
*            -> /state/.gh-token          (wooogy-hq)
```

Two traps when adding an org:

- A repo-local `credential.helper` does **not** win. It is a *generic* helper, and the URL-scoped
  `credential.https://github.com.helper` above is applied after it. Add the org to the router
  instead.
- `git clone` from the host still hits the global `credential.helper=store`, which answers first
  with the wrong token (`Write access to repository not granted`, 403). Reset the list with an
  empty value before overriding: `git -c credential.helper= -c credential.helper="store --file=…"`.

`git-credential-oc` lives only in `/state/bin/` — it is not in this repo and not created by the
Dockerfile. Losing the state mount loses every non-default org's git auth with no record of how to
rebuild it.

## Agent shell tool fails: `bwrap: No permissions to create a new namespace`

Every `bash` tool call the agent makes dies before running, and the agent — having no way to read
its own workspace — falls back to fetching files over public HTTPS. Private repos answer **404**
there, so the agent reports something like *"GitHub 연결이 승인되지 않았어"* and asks you to approve
a connection. **There is no connection to approve.** The clone on disk is fine; check
`git -C <repo> fetch` from inside the container before believing an auth story.

Cause: Codex wraps every shell command in bubblewrap, which must create a user namespace and
remount `/`. Docker's default seccomp profile blocks the first and its AppArmor profile the second.
The host sysctl is irrelevant — `kernel.unprivileged_userns_clone` was already `1` here; it is the
*container* policy that refuses.

Fix (already in `run.sh`):

```
--security-opt seccomp=unconfined --security-opt apparmor=unconfined
```

Both are required. Measured on this host, running the vendored bwrap as uid 1000:

| flags | result |
|---|---|
| (default) | `No permissions to create a new namespace` |
| `seccomp=unconfined` | `Failed to make / slave` (AppArmor) |
| `apparmor=unconfined` | `No permissions to create a new namespace` (seccomp) |
| `cap-add SYS_ADMIN` | `Failed to make / slave` |
| `apparmor=unconfined` + `cap-add SYS_ADMIN` | `pivot_root: Operation not permitted` |
| **`seccomp=unconfined` + `apparmor=unconfined`** | **OK** |

### Things that look like the fix and are not

- **`sandbox_mode = "danger-full-access"`** in the agent's `codex-home/config.toml`. Codex's own
  escape hatch, and it does work in a plain Codex CLI — but OpenClaw narrows the value back
  (openclaw/openclaw#83018), so the setting has no effect here.
- **`plugins.entries.codex.config.appServer.sandbox`**. The key exists in OpenClaw's schema and
  `config set` accepts it, but on 2026.7.1-2 it changes nothing, same upstream cause.
- **`tools.exec.host` / `agents.defaults.sandbox.mode`**. These govern OpenClaw's *own* sandbox,
  which defaults to `off` and was never the thing wrapping the command.
- **setuid on bwrap** (`chmod u+s`), the fix most often suggested online. The bwrap Codex ships is
  a static musl build that rejects it outright (`setuid use of bubblewrap is not supported in this
  build`), and the distro package instead fails at `capset` because Docker drops the capabilities
  it wants.

### What the flags cost

The container's syscall and mount confinement is given up; isolation still rests on uid 1000 and
the bind mounts in `run.sh`. In exchange Codex's per-command sandbox actually runs, which is the
layer that keeps an agent from touching anything outside its workspace — worth more here, since a
Discord channel lets anyone in the server put text in front of the agent. Revisit if
openclaw/openclaw#83018 lands: disabling the inner sandbox properly would let both flags go.

---

---

## General rules

- Change `gateway`/`channels`/`agents` **only via `.env` + redeploy** — hand-edits to
  `openclaw.json` don't survive the next boot. Runtime state (`mcp`, cron jobs, `meta`) persists on
  its own (cron in `/state/tasks/`, MCP in `openclaw.json` via the merge).
- `docker restart` does **not** re-read `.env`; use `bash run.sh` (recreate) to apply `.env` changes.
- Diagnosing telegram polling by hand with `curl …/getUpdates` **crashes** the running ingress
  (`Conflict: terminated by other getUpdates`) — only one consumer may poll a bot token. Prefer
  reading logs/state over `curl`.
