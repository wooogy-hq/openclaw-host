# Plan note: pluggable agent runtime (OpenClaw + Hermes) for OSS

> Status: **deferred** — captured for later. Not approved for implementation yet.
> Date: 2026-06-06. Owner: SeungWookHan.

## Goal

Generalize `openclaw-host` from an OpenClaw-only runtime into a runtime-neutral
**"machine-resident agent host with S3 state sync"**, so it can also front
**Hermes**, and OSS it. Concept: `<runtime> + S3`.

## What is actually shared vs runtime-specific

Splitting the current code by coupling:

**🟢 Runtime-neutral reusable core ("host")**
- `s3-sync.ts` — restore/backup mechanics
- `host.ts` + `index.ts` — lifecycle: restore → write config → spawn → periodic
  backup → graceful shutdown + final backup
- `supervisor.ts` — child-process supervision, signal forwarding, exit reporting
- Packaging — `Dockerfile`, `run.sh`, `docker-compose.yml`, systemd unit,
  skill install (`bin/install-skill`), MCP sidecars (`run-mcp-sidecar.sh`)

**🔴 OpenClaw-coupled ("runtime adapter")**
- `config.ts` — `buildOpenclawConfig()` (openclaw.json schema: gateway /
  channels.telegram / agents.defaults), `OPENCLAW_*` env names
- `provider-config.ts` — `openclawProvider/openclawApi/openclawAuth`, model
  string `provider/model`
- `s3-contract.ts` — session prefix `.../agents/default/sessions`, port 18789
- `supervisor.ts` — the `openclaw gateway run --port --bind loopback` argv
- `index.ts` — writes `openclaw.json`, sets `OPENCLAW_STATE_DIR`

## Hermes research findings (2026-06-06)

Hermes = `hermes-gateway` (npm, RayZhao1998/Hermes). **Sibling of OpenClaw, not a
fork.** Tagline: "turns ACP-compatible agents into an OpenClaw-style assistant."
Intentionally **workspace-compatible** with OpenClaw; documented migration is
essentially `cp -R ~/.openclaw/workspace/. ~/.hermes/workspace/`.

Across 6 dimensions — 3 are cosmetic, 3 are fundamental:

| Dimension | OpenClaw | Hermes | Gap |
|-----------|----------|--------|-----|
| Config | JSON, flat, regen-from-env each boot | YAML, hierarchical, static | 🟡 shape |
| Channels | Telegram native | Telegram + Discord (adapters) | 🟡 shape |
| Env/secrets | env-heavy | YAML-first, light env | 🟡 shape |
| CLI launch | `openclaw gateway run --port` (HTTP gateway) | `hermes start` (polling, no port) | 🔴 fundamental |
| State storage | S3-synced **durable** sessions + workspace | **in-memory** (ephemeral) sessions + workspace on disk | 🔴 fundamental |
| AI provider | host manages (anthropic/bedrock/deepseek) | none — ACP agent picks its own model | 🔴 fundamental |

**Key implication:** this project's core value is S3 **session** sync (shared with
serverless-openclaw). Hermes keeps sessions in memory → nothing durable to sync;
only **workspace** syncs. So S3 sync targets must be **per-runtime**, not global.

## Decision (recommended, pending approval)

**Approach B: single repo + runtime adapter selected by env, boundaries clean
enough to graduate to a monorepo (C) later.**

Rejected:
- **A (fully separate `hermes-host` repo)** — duplicates s3-sync + lifecycle +
  packaging; the two repos drift. Throws away the real reusable asset.
- **C (monorepo now)** — over-engineering at current size (7 source files); the
  tooling overhead lands before the benefit.

### Adapter interface (sketch)

```ts
interface RuntimeAdapter {
  // which (s3 prefix, local path) pairs to sync — OpenClaw=[workspace,sessions], Hermes=[workspace]
  syncTargets(cfg): Array<{ prefix: string; localPath: string }>;
  // render the runtime's native config file (openclaw.json | config.yaml) from env
  renderConfig(cfg): { path: string; contents: string };
  // argv to spawn the long-running process
  launchCommand(cfg): { command: string; args: string[]; env: Record<string,string> };
  // optional model/provider resolution (Hermes = no-op)
  resolveModel?(cfg): string;
}
```

Selection: `AGENT_RUNTIME=openclaw|hermes` (default `openclaw` for back-compat).
Core (`host.ts`) consumes only the adapter interface and never imports OpenClaw
specifics. The current `buildOpenclawConfig` / `provider-config` / `s3-contract`
session layout become the **openclaw adapter**.

### Hermes ephemeral sessions

Resolved by the adapter declaring `syncTargets()`: openclaw syncs
`[workspace, sessions]`, hermes syncs `[workspace]`. Core stays ignorant of
whether a runtime has durable sessions. (Adding session persistence *onto* Hermes
is explicitly out of scope for v1.)

### Naming

`openclaw-host` → a runtime-neutral name (candidates: `agent-host`, `claw-host`).
Decide when B/C is confirmed.

## Open items for when this is picked up
- Confirm Hermes config.yaml schema against current `hermes-gateway` version
  (research was doc-derived, not pinned to a version).
- Decide secret delivery for Hermes (it prefers tokens in YAML; we keep secrets
  in env — adapter must bridge).
- Map MCP sidecar wiring to Hermes' `mcpServers` config key.
- Reference Hermes' own OpenClaw→Hermes migration path for the workspace copy.
