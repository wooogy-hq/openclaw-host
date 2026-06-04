/**
 * Host configuration: load + validate env, and build the openclaw.json the
 * gateway runs with (native Telegram channel enabled).
 *
 * Security: secrets (bot token, AI API keys) are delivered via environment
 * variables only and are NEVER written into openclaw.json. OpenClaw reads
 * TELEGRAM_BOT_TOKEN / ANTHROPIC_API_KEY from the environment at runtime.
 *
 * Telegram schema verified against openclaw@2026.4.26 docs/channels/telegram.md.
 */
import { resolveProviderConfig, type ProviderConfig } from "./provider-config.js";
import { GATEWAY_PORT } from "./s3-contract.js";

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
const VALID_DM_POLICIES: readonly DmPolicy[] = ["pairing", "allowlist", "open", "disabled"];

export interface TelegramConfig {
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
}

export interface HostConfig {
  dataBucket: string;
  userId: string;
  awsRegion?: string;
  workspaceDir: string;
  /** OpenClaw state dir — config lives at {stateDir}/openclaw.json, sessions under
   *  {stateDir}/agents/default/sessions. Passed to the gateway as OPENCLAW_STATE_DIR. */
  stateDir: string;
  gatewayPort: number;
  backupIntervalMs: number;
  telegram: TelegramConfig;
  provider: ProviderConfig;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function loadConfig(env: Env = process.env): HostConfig {
  const dataBucket = required(env, "DATA_BUCKET");
  const userId = required(env, "USER_ID");
  // v1 channel is Telegram; the token is required (delivered via env).
  required(env, "TELEGRAM_BOT_TOKEN");

  const dmPolicy = (env.TELEGRAM_DM_POLICY ?? "pairing") as DmPolicy;
  if (!VALID_DM_POLICIES.includes(dmPolicy)) {
    throw new Error(
      `Invalid TELEGRAM_DM_POLICY: '${dmPolicy}'. Valid: ${VALID_DM_POLICIES.join(", ")}`,
    );
  }

  const allowFrom = (env.TELEGRAM_ALLOW_FROM ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Mirror OpenClaw: allowlist with no IDs blocks everything and is rejected.
  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    throw new Error("TELEGRAM_DM_POLICY=allowlist requires a non-empty TELEGRAM_ALLOW_FROM");
  }

  const awsRegion = env.AWS_REGION;

  return {
    dataBucket,
    userId,
    awsRegion,
    workspaceDir: env.WORKSPACE_DIR ?? "./data/workspace",
    stateDir: env.OPENCLAW_STATE_DIR ?? "./.openclaw",
    gatewayPort: env.OPENCLAW_GATEWAY_PORT ? Number(env.OPENCLAW_GATEWAY_PORT) : GATEWAY_PORT,
    backupIntervalMs: env.BACKUP_INTERVAL_MS ? Number(env.BACKUP_INTERVAL_MS) : 120000,
    telegram: { enabled: true, dmPolicy, allowFrom },
    provider: resolveProviderConfig({
      AI_PROVIDER: env.AI_PROVIDER,
      AI_MODEL: env.AI_MODEL,
      AWS_REGION: awsRegion,
    }),
  };
}

/**
 * Build the openclaw.json object. The bot token is intentionally omitted — it is
 * supplied via the TELEGRAM_BOT_TOKEN env var so no secret is written to disk.
 */
export function buildOpenclawConfig(cfg: HostConfig): Record<string, unknown> {
  const telegram: Record<string, unknown> = {
    enabled: cfg.telegram.enabled,
    dmPolicy: cfg.telegram.dmPolicy,
    groups: { "*": { requireMention: true } },
    // Disable live preview streaming. Default ("partial") streams partial
    // replies, but in this container the editMessageText path doesn't engage —
    // every partial/tool-progress update is sent as a NEW Telegram message, so
    // the answer appears to repeat itself. "off" sends one final message/turn.
    // NOTE: openclaw 2026.4.x accepts the STRING form ("off"); the object form
    // ({mode:"off"}) is silently dropped by config normalization.
    streaming: "off",
  };
  if (cfg.telegram.dmPolicy === "allowlist") {
    telegram.allowFrom = cfg.telegram.allowFrom;
  }

  return {
    gateway: { port: cfg.gatewayPort, mode: "local" },
    channels: { telegram },
    agents: {
      defaults: {
        model: { primary: `${cfg.provider.openclawProvider}/${cfg.provider.defaultModel}` },
        workspace: cfg.workspaceDir,
      },
    },
  };
}
