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

## `openclaw cron` fails: "requires credentials before opening a websocket"

**Symptom**
```
GatewayCredentialsRequiredError: gateway cron.list requires credentials before opening a websocket
Fix: configure gateway.auth token/password, pair this device, or pass --token/--password.
... unauthorized: gateway token not configured on gateway (set gateway.auth.token)
```
The agent also reports it "can't access cron," and you may see a **gateway restart** interrupt a
turn (the agent trying to self-fix `gateway.auth` triggers a restart).

**Root cause**
`openclaw cron` is managed *via the gateway* over an authenticated websocket. The generated
`openclaw.json` had **no `gateway.auth`**, so on each boot the gateway minted a throwaway
runtime token (`auth token was missing. Generated a runtime token for this startup`). Clients
(the agent, the `cron` CLI) had no matching token → every cron call was rejected.

Setting it at runtime with `openclaw config set gateway.auth.token …` does **not** survive a
restart — the boot rewrite of `openclaw.json` discards it (see above).

**Fix (persistent, env-driven)**
1. Put a stable token in `.env`:
   ```bash
   echo "OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)" >> .env
   ```
2. Redeploy (`bash run.sh`). `buildOpenclawConfig` now writes
   `gateway.auth = {mode:"token", token: <OPENCLAW_GATEWAY_TOKEN>}` on every boot, so the
   gateway and all local clients share one stable token.

**Verify**
```bash
docker logs --since 1m openclaw-host | grep -c "auth token was missing"   # -> 0
docker exec openclaw-host openclaw cron list                              # -> table, no error
```

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
