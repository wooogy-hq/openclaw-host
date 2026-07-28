#!/usr/bin/env node
/**
 * openclaw-host entry point — wires real dependencies into the host
 * orchestration (see host.ts) and owns the long-running lifecycle:
 *
 *   1. loadConfig (env)
 *   2. startup(): restore workspace + sessions from S3, write openclaw.json,
 *      spawn `openclaw gateway run`
 *   3. periodic S3 backup every BACKUP_INTERVAL_MS
 *   4. on SIGTERM/SIGINT or gateway exit: stop the gateway, final backup, exit
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, mergeOpenclawConfig } from "./config.js";
import { restoreFromS3, backupToS3 } from "./s3-sync.js";
import { GatewaySupervisor } from "./supervisor.js";
import { startup, shutdown, type HostDeps } from "./host.js";

/**
 * Write openclaw.json by MERGING our host-generated config over whatever is
 * already on disk. The host-managed keys (gateway/channels/agents) are
 * authoritative, but any other top-level keys added at runtime — notably `mcp`
 * from `openclaw mcp add` — are preserved instead of being wiped on every boot.
 */
function writeConfigFile(
  filePath: string,
  config: Record<string, unknown>,
  preserveAgentDefaults = false,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    // first boot or unreadable — start from an empty base
  }
  const merged = mergeOpenclawConfig(existing, config, preserveAgentDefaults);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Persist the GitHub token to an absolute file the git credential helper reads
 * (see Dockerfile). This is deliberately NOT git's `store` helper: on a failed
 * auth git calls `credential reject`, which erases the store file and silently
 * breaks every subsequent push. A plain file the helper `cat`s can't be wiped
 * that way, and reading from a file (not `$GITHUB_TOKEN`) survives OpenClaw's
 * sandboxed tool subprocesses, which run with the token scrubbed from their env.
 * Rewritten every boot so a rotated token in the env propagates.
 */
function writeGitToken(stateDir: string): void {
  const token = process.env.GITHUB_TOKEN;
  const file = path.join(stateDir, ".gh-token");
  if (!token) {
    console.warn("[openclaw-host] GITHUB_TOKEN unset — git pushes will fail until it is provided");
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // ensure 0600 even if the file pre-existed with looser perms
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Point the OpenClaw gateway at our state dir (absolute) so it reads the
  // openclaw.json we write and stores sessions where we back them up.
  const stateDir = path.resolve(config.stateDir);

  // Make the GitHub token available to git (credential helper reads this file).
  writeGitToken(stateDir);

  const supervisor = new GatewaySupervisor({
    port: config.gatewayPort,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    command: process.env.OPENCLAW_BIN, // defaults to "openclaw" on PATH
  });

  const deps: HostDeps = {
    config,
    restore: restoreFromS3,
    backup: backupToS3,
    writeConfigFile: (filePath, generated) =>
      writeConfigFile(filePath, generated, config.dynamicAgentDefaults),
    supervisor,
  };

  await startup(deps);
  console.log(
    `[openclaw-host] started for user=${config.userId} bucket=${config.dataBucket} ` +
      `provider=${config.provider.provider} model=${config.provider.defaultModel}`,
  );

  const backupTimer = setInterval(() => {
    shutdown(deps).catch((err) => console.warn("[openclaw-host] periodic backup failed:", err));
  }, config.backupIntervalMs);

  let shuttingDown = false;
  async function gracefulExit(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[openclaw-host] shutting down (${reason}); running final backup...`);
    clearInterval(backupTimer);
    supervisor.stop("SIGTERM");
    await shutdown(deps).catch((err) => console.warn("[openclaw-host] final backup failed:", err));
    process.exit(0);
  }

  process.on("SIGTERM", () => void gracefulExit("SIGTERM"));
  process.on("SIGINT", () => void gracefulExit("SIGINT"));

  // If the gateway exits on its own (crash or completion), back up and exit so
  // the init system (systemd/Docker) can restart us from a clean state.
  const code = await supervisor.waitForExit();
  await gracefulExit(`gateway exited code=${code ?? "null"}`);
}

main().catch((err) => {
  console.error("[openclaw-host] fatal:", err);
  process.exit(1);
});
