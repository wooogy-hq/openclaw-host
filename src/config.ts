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
  /** Gateway auth token written into openclaw.json as gateway.auth.token. Required
   *  so the agent + `openclaw cron` (which talk to the gateway over a websocket)
   *  can authenticate. Delivered via the OPENCLAW_GATEWAY_TOKEN env var (.env), so
   *  it is stable across restarts. Empty => no auth block is written. */
  gatewayToken: string;
  backupIntervalMs: number;
  /** Restore workspace/session objects from S3 before starting the gateway.
   *  Long-lived hosts with already-populated bind mounts can disable this to
   *  avoid replaying stale historical objects on every container restart. */
  restoreOnStart: boolean;
  telegram: TelegramConfig;
  provider: ProviderConfig;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function booleanEnv(env: Env, name: string, defaultValue: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be 'true' or 'false'`);
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
    // index.ts overrides this with a persisted token when the env var is unset.
    gatewayToken: env.OPENCLAW_GATEWAY_TOKEN ?? "",
    backupIntervalMs: env.BACKUP_INTERVAL_MS ? Number(env.BACKUP_INTERVAL_MS) : 120000,
    restoreOnStart: booleanEnv(env, "RESTORE_ON_START", true),
    telegram: { enabled: true, dmPolicy, allowFrom },
    provider: resolveProviderConfig({
      AI_PROVIDER: env.AI_PROVIDER,
      AI_MODEL: env.AI_MODEL,
      AI_AUTH: env.AI_AUTH,
      AI_BASE_URL: env.AI_BASE_URL,
      AI_OPENCLAW_API: env.AI_OPENCLAW_API,
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
    // NOTE: openclaw 2026.6.x REQUIRES the object form ({mode:"off"}) and
    // rejects the string "off" ("must be object"). (2026.4.x was the opposite —
    // it stripped the object; we run 2026.6.1, so object form it is.)
    streaming: { mode: "off" },
  };
  if (cfg.telegram.dmPolicy === "allowlist") {
    telegram.allowFrom = cfg.telegram.allowFrom;
  }

  // gateway.auth.token must be present (and stable) or the agent + `openclaw cron`
  // can't open their gateway websocket ("requires credentials"). The gateway is
  // loopback-bound; this token is shared by the local clients via this same file.
  const gateway: Record<string, unknown> = { port: cfg.gatewayPort, mode: "local" };
  if (cfg.gatewayToken) {
    gateway.auth = { mode: "token", token: cfg.gatewayToken };
  }

  const result: Record<string, unknown> = {
    gateway,
    channels: { telegram },
    agents: {
      defaults: {
        model: { primary: `${cfg.provider.openclawProvider}/${cfg.provider.defaultModel}` },
        workspace: cfg.workspaceDir,
      },
    },
  };

  // Custom OpenAI/Anthropic-compatible endpoints need an explicit provider block
  // so openclaw knows the base URL + API family. Named providers with built-in
  // endpoints (anthropic/deepseek/bedrock/openai) omit this. The API key is
  // NEVER inlined — it stays in env and is referenced via ${AI_API_KEY}
  // interpolation, so no secret lands in openclaw.json.
  if (cfg.provider.baseUrl) {
    const providerBlock: Record<string, unknown> = {
      baseUrl: cfg.provider.baseUrl,
      api: cfg.provider.openclawApi,
    };
    if (cfg.provider.authMode === "api-key") {
      providerBlock.apiKey = "${AI_API_KEY}";
    }
    result.models = { providers: { [cfg.provider.openclawProvider]: providerBlock } };
  }

  return result;
}

/**
 * Merge our host-generated config over the existing openclaw.json. openclaw.json
 * is rewritten on every boot from env; a plain overwrite would wipe top-level
 * keys added at runtime (e.g. `mcp` from `openclaw mcp add`, or `meta`). Shallow
 * merge keeps host-managed keys (gateway/channels/agents) authoritative while
 * preserving everything else the running gateway persisted.
 */
export function mergeOpenclawConfig(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...generated };
}
