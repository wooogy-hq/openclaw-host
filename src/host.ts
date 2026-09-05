/**
 * Host orchestration: the only module that knows the startup/shutdown order.
 * Collaborators are injected so the sequence and S3 prefixes can be tested
 * without touching the real filesystem, S3, or child processes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostConfig } from "./config.js";
import type { SyncParams } from "./s3-sync.js";
import { workspacePrefix, sessionsPrefix, agentsPrefix } from "./s3-contract.js";

export interface SupervisorLike {
  start(): void;
  waitForExit(): Promise<number | null>;
  stop(signal?: NodeJS.Signals): void;
}

export interface HostDeps {
  config: HostConfig;
  restore: (params: SyncParams) => Promise<number>;
  backup: (params: SyncParams) => Promise<number>;
  writeConfigFile: (filePath: string, config: Record<string, unknown>) => void;
  supervisor: SupervisorLike;
  /** Agent ids that have a local session dir. Injected for tests; defaults to a
   *  scan of {stateDir}/agents. */
  listAgentIds?: (stateDir: string) => string[];
}

/**
 * Agent ids with a local session dir, e.g. `main` (and the legacy `default`).
 * OpenClaw names the dir after the agent id, so `openclaw agents add work`
 * shows up here on its own — no config parsing and no hardcoded id list.
 *
 * Only `{stateDir}/agents/<id>/sessions` is ever returned. The sibling
 * `<id>/agent/` dir holds the provider OAuth store and must never be backed up.
 */
function scanAgentIds(stateDir: string): string[] {
  const agentsDir = path.join(stateDir, "agents");
  try {
    return fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(agentsDir, e.name, "sessions")))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no agents dir yet (fresh machine) — nothing to back up
  }
}

/** Backup pairs: the workspace plus one session dir per existing agent. */
function backupTargets(
  cfg: HostConfig,
  agentIds: string[],
): Array<Pick<SyncParams, "prefix" | "localPath">> {
  return [
    { prefix: workspacePrefix(cfg.userId), localPath: cfg.workspaceDir },
    ...agentIds.map((id) => ({
      prefix: sessionsPrefix(cfg.userId, id),
      localPath: path.join(cfg.stateDir, "agents", id, "sessions"),
    })),
  ];
}

/**
 * Restore pairs. Agent ids can't be scanned locally here — the dirs are what we
 * are about to restore — so we pull the whole `agents/` parent in one go. Every
 * agent's sessions land back under their own id, and backup only ever writes
 * `<id>/sessions/` there, so nothing else can come down with them.
 */
function restoreTargets(cfg: HostConfig): Array<Pick<SyncParams, "prefix" | "localPath">> {
  return [
    { prefix: workspacePrefix(cfg.userId), localPath: cfg.workspaceDir },
    { prefix: agentsPrefix(cfg.userId), localPath: path.join(cfg.stateDir, "agents") },
  ];
}

/**
 * Restore shared state from S3, write openclaw.json, then start the gateway.
 * Imported lazily to avoid a circular import with buildOpenclawConfig.
 */
export async function startup(deps: HostDeps): Promise<void> {
  const { config, restore, writeConfigFile, supervisor } = deps;
  const { buildOpenclawConfig } = await import("./config.js");

  if (config.restoreOnStart) {
    for (const t of restoreTargets(config)) {
      await restore({
        bucket: config.dataBucket,
        prefix: t.prefix,
        localPath: t.localPath,
        region: config.awsRegion,
      });
    }
  }

  writeConfigFile(path.join(config.stateDir, "openclaw.json"), buildOpenclawConfig(config));

  supervisor.start();
}

/** Back up shared state to S3 (periodic tick and graceful shutdown).
 *  No-op when BACKUP_ENABLED=false — gated here, the single path both the
 *  periodic tick and the final shutdown backup go through. */
export async function shutdown(deps: HostDeps): Promise<void> {
  const { config, backup } = deps;
  if (!config.backupEnabled) return;
  const agentIds = (deps.listAgentIds ?? scanAgentIds)(config.stateDir);
  for (const t of backupTargets(config, agentIds)) {
    await backup({
      bucket: config.dataBucket,
      prefix: t.prefix,
      localPath: t.localPath,
      region: config.awsRegion,
      // Incremental: only re-upload files changed since the last backup.
      manifestPath: path.join(config.stateDir, ".s3-sync-manifest.json"),
    });
  }
}
