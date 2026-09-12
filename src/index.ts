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
import { execFileSync } from "node:child_process";
import { loadConfig, mergeOpenclawConfig } from "./config.js";
import {
  applyCompat,
  capabilitiesFor,
  parseVersion,
  type Capabilities,
} from "./openclaw-compat.js";
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
  caps: Capabilities = capabilitiesFor(undefined),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    // first boot or unreadable — start from an empty base
  }
  const merged = mergeOpenclawConfig(existing, config, preserveAgentDefaults);
  // After the merge, not before: the roster we may have to reshape is a key we
  // preserve from disk rather than one we generate.
  for (const change of applyCompat(merged, caps)) {
    console.log(`[openclaw-host] config compat: ${change}`);
  }
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Ask the installed CLI what it is. A failure here is not fatal: capabilitiesFor
 * treats an unknown version as the older config shape, which a newer gateway
 * repairs on its own — the opposite guess would hand an older gateway a key it
 * refuses to start on.
 */
/**
 * Hand the config we just wrote to OpenClaw's own validator and print what it
 * says, before the gateway tries to boot on it.
 *
 * This is not belt-and-braces. From 2026.8.1 Discord and Codex ship as external
 * plugins installed into the STATE VOLUME, not the image — so bumping
 * OPENCLAW_VERSION in the Dockerfile carries the new gateway but not its
 * channels, and the only symptom is a channel that never connects. `config
 * validate` names the missing plugin and the exact install command, so surface
 * it rather than reimplementing the check and letting the two drift.
 *
 * Advisory: a failure here is reported, not fatal. If the config really is
 * unusable the gateway says so itself, and refusing to start on our own reading
 * of it would turn a warning into an outage.
 */
function reportConfigHealth(bin: string, env: NodeJS.ProcessEnv): void {
  try {
    const out = execFileSync(bin, ["config", "validate"], {
      encoding: "utf-8",
      env,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of out.trim().split("\n")) {
      if (line.trim()) console.log(`[openclaw-host] config: ${line.trim()}`);
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = (e.stdout ?? "") + (e.stderr ?? "") || e.message || "";
    console.error("[openclaw-host] config validate reported problems:");
    for (const line of detail.trim().split("\n")) {
      if (line.trim()) console.error(`[openclaw-host]   ${line.trim()}`);
    }
  }
}

function detectGatewayVersion(bin: string): Capabilities {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 30_000 });
    const version = parseVersion(out);
    if (!version) {
      console.warn(`[openclaw-host] could not parse '${bin} --version': ${out.trim()}`);
    }
    return capabilitiesFor(version);
  } catch (err) {
    console.warn(`[openclaw-host] could not run '${bin} --version':`, (err as Error).message);
    return capabilitiesFor(undefined);
  }
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

  const openclawBin = process.env.OPENCLAW_BIN ?? "openclaw";
  const capabilities = detectGatewayVersion(openclawBin);

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
      writeConfigFile(filePath, generated, config.dynamicAgentDefaults, capabilities),
    supervisor,
    capabilities,
  };

  await startup(deps);
  reportConfigHealth(openclawBin, { ...process.env, OPENCLAW_STATE_DIR: stateDir });
  console.log(
    `[openclaw-host] started for user=${config.userId} bucket=${config.dataBucket} ` +
      `provider=${config.provider.provider} model=${config.provider.defaultModel} ` +
      `openclaw=${capabilities.version?.join(".") ?? "unknown"} roster=${capabilities.rosterKey}`,
  );
  if (!config.backupEnabled) {
    // Logged once here rather than on every tick: silence about a disabled
    // backup is exactly how you discover it the day you need the copy.
    console.warn("[openclaw-host] BACKUP_ENABLED=false — state stays on this machine only");
  }

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
