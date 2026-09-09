# Running against more than one OpenClaw version

`openclaw-host` rewrites `openclaw.json` on every boot, so it decides the config
shape the gateway is handed. That makes version drift this host's problem rather
than the operator's.

OpenClaw 2026.8.1 — marketed as **"OpenClaw 2.0"**, released 2026-08-31 — changed
that shape in ways that break in *both* directions. 2026.7.x refuses
`agents.entries`; 2026.8.1+ refuses `agents.list`. A host that emits one fixed
shape works on exactly one side of that line, and a version bump or a rollback
becomes a gateway that will not start.

So `src/openclaw-compat.ts` reads `openclaw --version` at boot and emits what
that version accepts. `ARG OPENCLAW_VERSION` in the Dockerfile is a real knob.

## What actually differs

Verified by diffing `openclaw config schema` between 2026.7.1-2 and 2026.9.2, and
by round-tripping this host's real config through both binaries.

| 2026.7.x | 2026.8.1+ | Why it matters |
|---|---|---|
| `agents.list` (array of `{id, …}`) | `agents.entries` (keyed by id) | Hard error either way |
| — | `agents.ownership: "explicit"` | A fleet without it fails closed: cron, heartbeat and bare CLI calls can't resolve an owner |
| `agents.defaults.models` | `agents.defaults.modelPolicy.allow` | Aliases and restrictions were separated |
| `agents.defaults.memorySearch` | `memory.search` | Per-agent form moved too: `<agent>.memorySearch` → `<agent>.memory.search` |
| per-agent `groupChat.visibleReplies` | `messages.groupChat.visibleReplies` | **One-way.** 2.0 has no per-agent override; the global key is valid on both, so the fix lands on the shape both accept and widens the setting to every agent |
| `meta.lastTouchedAt`, `plugins.bundledDiscovery` | rejected | Written by 2026.7.x itself, so an untouched config still trips the newer validator |
| `agents/<id>/sessions/*.jsonl` | `agents/<id>/agent/openclaw-agent.sqlite` | Changes what a backup must copy — see below |

**Not** version-specific, despite looking it: `messages.groupChat.visibleReplies`,
`tools.sessions`, `tools.agentToAgent` are accepted by both. Prefer those.

## Things that look like differences and are not

- **Channel and provider plugins.** `discord`, `codex` and `deepseek` are already
  external plugins on 2026.7.x, installed into `$OPENCLAW_STATE_DIR/npm/projects`.
  That directory is a volume, so they survive a version bump; a 2026.9.2 runtime
  loads plugins installed under 2026.7.1-2 without complaint. If a `config
  validate` run reports them missing, check whether `npm/` was excluded from
  whatever state copy is being validated before concluding anything.
- **Plugin "suspicious ownership" warnings.** The check compares the plugin
  files' uid against the running process. Production passes it because `run.sh`
  passes `--user 1000:1000` (overriding the Dockerfile's `USER oc`) and the
  bind-mounted state is owned by uid 1000 on the host. Validating the same state
  from a container running as root produces warnings that mean nothing.

## Backups change shape at 2026.8.1

Before: transcripts are `.jsonl` under `agents/<id>/sessions/`, and this host
syncs that directory to S3.

After: they live in `agents/<id>/agent/openclaw-agent.sqlite`. The `.jsonl` files
become exports and orphans — on this deployment, 18,223 of them against 6 live
sessions. Syncing that directory would look like a working backup and restore
nothing.

The obvious repair is worse. That same SQLite file holds the provider OAuth
store, so backing up `agent/` would push refresh credentials into S3. There is no
file-level split, so `backupTargets()` drops the session prefixes on 2026.8.1+
and `startup()` says so once. Session history needs OpenClaw's own tooling:

```
openclaw backup sqlite create --agent <id> --repository <dir>
openclaw backup sqlite verify <dir>/<snapshot-id>
```

## Operator commands

```
# What would change for a given target, without booting anything
node bin/openclaw-compat.mjs /state/openclaw.json --version 2026.9.2
node bin/openclaw-compat.mjs /state/openclaw.json --version 2026.9.2 --write

# Confirm with OpenClaw's own validator
openclaw config validate
```

The host applies the identical transform at boot (`src/index.ts`), from the same
module, so the CLI and the runtime cannot drift.

`openclaw doctor --fix` does *not* substitute for this: it prompts before these
changes, and `--non-interactive` skips them ("safe migrations only"). A container
has no TTY, so an unattended upgrade would boot on a config the new gateway
rejects.

## Upgrading

1. Snapshot state — `bin/backup-to-nas.sh`. Read its header first: that copy is
   on the same disk as the original, which covers a bad migration but not a dead
   disk.
2. Bump `ARG OPENCLAW_VERSION`, rebuild, restart. The config reshapes itself and
   the boot log lists every change.
3. Read the `[openclaw-host] config:` lines. On a fleet, expect
   `agents.defaults.heartbeat.agentId` — 2.0 keeps heartbeats disabled until a
   multi-agent roster names an owner.
4. Session transcripts are a **separate, opt-in** step, after the gateway is
   confirmed healthy:
   ```
   openclaw doctor --session-sqlite dry-run --session-sqlite-agent <id>
   openclaw doctor --session-sqlite import   --session-sqlite-agent <id>
   ```

Rolling back is the same loop with the older version in the ARG.
