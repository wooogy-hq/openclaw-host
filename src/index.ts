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
import { loadConfig } from "./config.js";
import { restoreFromS3, backupToS3 } from "./s3-sync.js";
import { GatewaySupervisor } from "./supervisor.js";
import { startup, shutdown, type HostDeps } from "./host.js";

function writeConfigFile(filePath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Point the OpenClaw gateway at our state dir (absolute) so it reads the
  // openclaw.json we write and stores sessions where we back them up.
  const stateDir = path.resolve(config.stateDir);
  const supervisor = new GatewaySupervisor({
    port: config.gatewayPort,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    command: process.env.OPENCLAW_BIN, // defaults to "openclaw" on PATH
  });

  const deps: HostDeps = {
    config,
    restore: restoreFromS3,
    backup: backupToS3,
    writeConfigFile,
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
