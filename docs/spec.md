# Spec: openclaw-host

> Status: **DRAFT — awaiting review** · Date: 2026-05-30 · Owner: SeungWookHan

A standalone, machine-resident OpenClaw runtime that persists its state to the
same S3 bucket used by the `serverless-openclaw` deployment. It runs OpenClaw
with its **native channels** (Telegram, etc.) as an always-on service ("like an
OS default"), so a plain VM/box becomes a full agent host without any API
Gateway / Lambda / DynamoDB.

This project is **carved out** from `serverless-openclaw` (approach B): the
serverless repo is left untouched. openclaw-host is its own private repo because
it has evolved into a meaningfully different product.

---

## Assumptions

> Correct any of these now, or implementation proceeds with them.

1. **Native channels, not headless.** OpenClaw connects to chat channels itself
   via `openclaw.json` `channels.*`. We do **not** port the serverless project's
   `openclaw-client.ts` (JSON-RPC backend driver), `device-identity.ts`, or
   `bridge.ts`. (This is the key simplification — OpenClaw supports 15+ channels
   natively; the serverless side only disabled them via `--skip-channels`.)
2. **Shared S3 bucket.** openclaw-host points at the same `DATA_BUCKET` and uses
   the same `USER_ID` as the serverless deployment, so workspace state is shared.
3. **v1 channel = Telegram.** Other channels (Slack, Discord, WhatsApp, …) are
   config-only additions and explicitly out of scope for v1 implementation.
4. **AWS credentials via standard chain.** Env vars, `~/.aws/credentials`, or an
   instance role. No SSM dependency (device identity is not used).
5. **Single user per host.** One `USER_ID` per running instance, matching the
   serverless per-user container model.
6. **OpenClaw installed globally** (`npm i -g openclaw@<pinned>`) and on `PATH`.
7. **Node.js >= 22.12** (OpenClaw requirement). Dev box here is Node 26.

---

## Objective

**What:** A self-contained service that turns any machine into an OpenClaw agent
host, sharing conversation/workspace state with the existing serverless system
through S3.

**Why:** The serverless deployment pays for cold starts and per-message compute.
A persistent machine (home server, cheap VPS, spare box) can run the same agent
continuously, and — because state lives in the shared bucket — work done on the
machine shows up in the web/Telegram serverless paths and vice versa.

**User:** The maintainer (solo), installing on machines they control.

**Success looks like:** `git clone` → set `.env` → `npm install && npm start`
(or `docker run` / `systemctl start openclaw-host`) brings up OpenClaw answering
on Telegram, with workspace + sessions restored from and backed up to S3.

---

## Tech Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js >= 22.12 (ESM, `type: module`) |
| Language | TypeScript ES2022, strict, Node16 module resolution |
| Agent engine | `openclaw` CLI (`openclaw gateway run`), pinned version |
| Cloud SDK | `@aws-sdk/client-s3` only |
| Test | vitest |
| Packaging | npm + Dockerfile + systemd unit |

No CDK, no DynamoDB, no API Gateway, no Express/Bridge.

---

## Commands

```bash
npm install           # install deps
npm run build         # tsc -> dist/
npm start             # node dist/index.js (restore -> spawn -> supervise)
npm run dev           # tsc --watch
npm run lint          # eslint src
npm test              # vitest run

# Operational
docker build -t openclaw-host .
docker run --env-file .env openclaw-host
sudo systemctl start openclaw-host    # via provided unit file
```

---

## Project Structure

```
openclaw-host/
├── src/
│   ├── index.ts          # Entry: config -> restore -> config-write -> spawn -> backup loop
│   ├── config.ts         # Load/validate env; build openclaw.json (channels ON + provider/model/workspace)
│   ├── s3-sync.ts        # Recursive S3 <-> local sync (workspace + sessions). Ported from container/s3-sync.ts
│   ├── s3-contract.ts    # VENDORED S3 layout constants (must match serverless shared)  [done]
│   ├── supervisor.ts     # Spawn & supervise `openclaw gateway run`; signal handling
│   └── provider-config.ts# Provider/model resolution. Ported from serverless shared/provider-config.ts
├── __tests__/            # vitest unit tests (s3-sync, config, provider-config)
├── docs/
│   └── spec.md           # this file
├── Dockerfile            # machine image
├── deploy/
│   └── openclaw-host.service   # systemd unit
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Architecture

```
                       same S3 bucket (DATA_BUCKET)
   serverless-openclaw  ───────────────┬───────────────  openclaw-host (this)
   (web / telegram via                 │
    API GW + Lambda/Fargate)           │
                                        │  workspaces/{userId}/...
                                        │  sessions/{userId}/agents/default/sessions/*.jsonl
                                        │
   on the machine:
     index.ts
        ├─ restore workspace + sessions from S3   (s3-sync)
        ├─ write ~/.openclaw/openclaw.json        (config: channels ON)
        ├─ spawn: openclaw gateway run --port 18789   (supervisor)
        │     └─ OpenClaw connects to Telegram natively, runs the agent,
        │        writes sessions + workspace files locally
        ├─ every BACKUP_INTERVAL_MS: backup workspace + sessions to S3
        └─ on SIGTERM/SIGINT: final backup, then exit
```

**Boundary clarity:**
- `config.ts` — input: env; output: a valid `openclaw.json`. No I/O beyond the file.
- `s3-sync.ts` — pure S3<->fs mirroring given (bucket, prefix, localPath).
- `supervisor.ts` — owns the child process lifecycle only.
- `index.ts` — orchestrates the above; the only module that knows the order.

---

## S3 Contract (shared state)

Both sides MUST agree on these paths (see `src/s3-contract.ts`):

| Data | S3 key prefix | Local path |
|---|---|---|
| Workspace | `workspaces/{userId}/` | `WORKSPACE_DIR` |
| Sessions | `sessions/{userId}/agents/default/sessions/` | `{OPENCLAW_HOME}/agents/default/sessions/` |

**Drift guard:** `s3-contract.ts` carries a comment pointing at the serverless
source of truth. A test asserts the literal values so an accidental edit fails CI.

**Known limitation:** Workspace files are a strong shared anchor (same git repo,
`AGENTS.md`, code). Session **transcript continuity** across the native-channel
host and the serverless JSON-RPC path may not be 1:1, because session IDs are
generated per entry point. We sync the whole sessions directory regardless; we do
not promise turn-by-turn conversation merging in v1.

---

## Code Style

Match serverless-openclaw conventions: strict TS, named exports, small focused
modules, `.js` extension in relative imports (Node16 ESM).

```ts
// s3-sync.ts — dependency-injected, side-effect-isolated, testable
export interface SyncParams {
  bucket: string;
  prefix: string;
  localPath: string;
  region?: string;
}

export async function restoreFromS3(params: SyncParams): Promise<number> {
  const client = new S3Client({ region: params.region });
  // ... list + get, return count
}
```

- Env access centralized in `config.ts`; other modules receive plain params.
- No secrets written to disk inside `openclaw.json` (keys via env only) — carry
  over the serverless security rule.

---

## Testing Strategy

- **Framework:** vitest, tests in `__tests__/`.
- **Unit (mock S3):** `s3-sync` (pagination, nested paths, empty prefix),
  `config` (channels-on output, provider resolution, missing-env errors),
  `provider-config` (anthropic/bedrock/deepseek), `s3-contract` (literal values).
- **Integration (optional, real bucket):** restore→backup round-trip against a
  throwaway prefix, gated behind an env flag like the serverless e2e tests.
- **Manual smoke:** `npm start` with a real Telegram bot token; send a message,
  confirm a reply and that `sessions/{userId}/...` appears in S3.
- Coverage target: the three pure modules (`s3-sync`, `config`, `provider-config`)
  should be well covered; `supervisor`/`index` verified via smoke test.

---

## Boundaries

**Always**
- Keep `s3-contract.ts` values identical to serverless `shared`.
- Deliver API keys via env only; never write them into `openclaw.json`.
- Run `npm run build` + `npm test` before commits.
- Back up to S3 on graceful shutdown.

**Ask first**
- Adding a second channel beyond Telegram.
- Changing the S3 layout / prefixes (affects the serverless side).
- Adding dependencies beyond `@aws-sdk/client-s3`.
- Anything that writes to the shared bucket outside the two contract prefixes.

**Never**
- Modify the `serverless-openclaw` repo from here.
- Commit `.env`, tokens, or `*.identity.json`.
- Use long-polling AND webhook for Telegram simultaneously (native channel uses
  one mode — let OpenClaw own it).
- Delete S3 objects as part of normal sync (mirror is upload/overwrite only).

---

## Success Criteria

1. Fresh machine: `clone → .env → npm install → npm start` brings OpenClaw up
   answering on Telegram. (manual smoke)
2. On start, existing `workspaces/{userId}/` and `sessions/{userId}/...` from the
   serverless bucket are restored to local disk. (integration/manual)
3. After a conversation, new/updated workspace + session files are pushed to the
   same S3 prefixes within one backup interval and on shutdown. (integration/manual)
4. A file created by the machine appears in the serverless web/Telegram workspace
   (and vice versa), proving shared state. (manual cross-check)
5. `npm test` green; `s3-contract` test pins the layout values.
6. `docker run --env-file .env` and the systemd unit both start the service.

---

## Open Questions

1. **Exact `openclaw.json` `channels.telegram` schema** for the pinned OpenClaw
   version — needs verification against the installed package (the serverless
   side only ever *deleted* this key, so we lack a positive example). Resolve in
   the `config.ts` task by inspecting `node_modules/openclaw` / onboard output.
2. **Allowed-chat-id / auth** for the Telegram channel — does OpenClaw native
   Telegram support an allowlist, or do we rely on bot privacy + a known chat?
3. **OpenClaw version pin** — match the serverless `OPENCLAW_VERSION`
   (2026.4.26) or take latest? Default: match serverless for session-format
   compatibility.
4. **Concurrent writers** — if the serverless Fargate container and this host run
   for the same `userId` at once, both back up to the same prefix (last-writer-
   wins). v1 assumes they don't overlap; document it. Worth a guard later?

---

## Implementation Phases (preview — for Plan/Tasks after spec approval)

1. **Scaffold + contract** (done): repo, package.json, tsconfig, `s3-contract.ts`.
2. **Port pure modules:** `s3-sync.ts`, `provider-config.ts` + unit tests (TDD).
3. **`config.ts`:** build channels-on `openclaw.json`; resolve Open Question #1.
4. **`supervisor.ts`:** spawn/supervise `openclaw gateway run`, signal handling.
5. **`index.ts`:** wire lifecycle (restore → config → spawn → backup loop → shutdown).
6. **Packaging:** Dockerfile + systemd unit; smoke test on a real box.
7. **Docs:** README quickstart; note the shared-bucket cross-check.
