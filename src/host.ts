/**
 * Host orchestration: the only module that knows the startup/shutdown order.
 * Collaborators are injected so the sequence and S3 prefixes can be tested
 * without touching the real filesystem, S3, or child processes.
 */
import * as path from "node:path";
import type { HostConfig } from "./config.js";
import type { SyncParams } from "./s3-sync.js";
import { workspacePrefix, sessionsPrefix } from "./s3-contract.js";

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
}

/** Local path where OpenClaw stores session transcripts. */
function sessionsLocalPath(cfg: HostConfig): string {
  return path.join(cfg.openclawHome, "agents", "default", "sessions");
}

/** The two (prefix, localPath) pairs that make up shared state. */
function syncTargets(cfg: HostConfig): Array<Pick<SyncParams, "prefix" | "localPath">> {
  return [
    { prefix: workspacePrefix(cfg.userId), localPath: cfg.workspaceDir },
    { prefix: sessionsPrefix(cfg.userId), localPath: sessionsLocalPath(cfg) },
  ];
}

/**
 * Restore shared state from S3, write openclaw.json, then start the gateway.
 * Imported lazily to avoid a circular import with buildOpenclawConfig.
 */
export async function startup(deps: HostDeps): Promise<void> {
  const { config, restore, writeConfigFile, supervisor } = deps;
  const { buildOpenclawConfig } = await import("./config.js");

  for (const t of syncTargets(config)) {
    await restore({
      bucket: config.dataBucket,
      prefix: t.prefix,
      localPath: t.localPath,
      region: config.awsRegion,
    });
  }

  writeConfigFile(path.join(config.openclawHome, "openclaw.json"), buildOpenclawConfig(config));

  supervisor.start();
}

/** Back up shared state to S3 (periodic tick and graceful shutdown). */
export async function shutdown(deps: HostDeps): Promise<void> {
  const { config, backup } = deps;
  for (const t of syncTargets(config)) {
    await backup({
      bucket: config.dataBucket,
      prefix: t.prefix,
      localPath: t.localPath,
      region: config.awsRegion,
    });
  }
}
