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
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";
const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
];

function isValidAgentModelConfig(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const model = value as Record<string, unknown>;
  if (Object.keys(model).some((key) => !["primary", "fallbacks", "timeoutMs"].includes(key))) {
    return false;
  }
  if (
    model.primary !== undefined &&
    (typeof model.primary !== "string" || model.primary.length === 0)
  ) {
    return false;
  }
  if (
    model.fallbacks !== undefined &&
    (!Array.isArray(model.fallbacks) ||
      !model.fallbacks.every(
        (fallback) => typeof fallback === "string" && fallback.length > 0,
      ))
  ) {
    return false;
  }
  if (
    model.timeoutMs !== undefined &&
    (typeof model.timeoutMs !== "number" ||
      !Number.isInteger(model.timeoutMs) ||
      model.timeoutMs <= 0)
  ) {
    return false;
  }
  return true;
}

export interface TelegramConfig {
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
}

/** Optional second channel. Same shape as Telegram — the Discord channel plugin
 *  reads the same dmPolicy/allowFrom/streaming keys, with `guilds` where
 *  Telegram has `groups`. Disabled unless DISCORD_BOT_TOKEN is set. */
export interface DiscordConfig {
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
  /** Mirror workspace/session state to S3 (periodic tick + final backup on
   *  shutdown). Off makes the host purely machine-local: no PUT/LIST requests
   *  and no S3 cost, at the price of no off-machine copy. Pairs with
   *  RESTORE_ON_START — with both off, S3 is not touched at all. */
  backupEnabled: boolean;
  telegram: TelegramConfig;
  /** Present only when DISCORD_BOT_TOKEN is set. openclaw.json's `channels` key
   *  is regenerated from env on every boot, so a Discord account added at
   *  runtime with `openclaw channels add` would be wiped by the next restart —
   *  it has to come from here to survive. */
  discord?: DiscordConfig;
  provider: ProviderConfig;
  /** Default model reasoning effort when a session/message does not override it. */
  thinkingDefault?: ThinkingLevel;
  /** Treat valid runtime-written agent defaults as authoritative across restarts.
   *  AI_MODEL/AI_THINKING remain bootstrap and invalid-config recovery defaults. */
  dynamicAgentDefaults: boolean;
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

function thinkingEnv(env: Env): ThinkingLevel | undefined {
  const value = env.AI_THINKING;
  if (value === undefined || value === "") return undefined;
  if (VALID_THINKING_LEVELS.includes(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(
    `AI_THINKING must be one of: ${VALID_THINKING_LEVELS.join(", ")}`,
  );
}

/**
 * Discord is opt-in: absent DISCORD_BOT_TOKEN, no `channels.discord` is emitted
 * and the existing Telegram-only setup is untouched. Defaults to an allowlist so
 * an unconfigured bot invite cannot let strangers DM the agent.
 */
function loadDiscordConfig(env: Env): DiscordConfig | undefined {
  if (!env.DISCORD_BOT_TOKEN) return undefined;

  const dmPolicy = (env.DISCORD_DM_POLICY ?? "allowlist") as DmPolicy;
  if (!VALID_DM_POLICIES.includes(dmPolicy)) {
    throw new Error(
      `Invalid DISCORD_DM_POLICY: '${dmPolicy}'. Valid: ${VALID_DM_POLICIES.join(", ")}`,
    );
  }

  const allowFrom = (env.DISCORD_ALLOW_FROM ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    throw new Error("DISCORD_DM_POLICY=allowlist requires a non-empty DISCORD_ALLOW_FROM");
  }

  return { enabled: true, dmPolicy, allowFrom };
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

  const discord = loadDiscordConfig(env);

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
    backupEnabled: booleanEnv(env, "BACKUP_ENABLED", true),
    telegram: { enabled: true, dmPolicy, allowFrom },
    ...(discord ? { discord } : {}),
    thinkingDefault: thinkingEnv(env),
    dynamicAgentDefaults: booleanEnv(env, "DYNAMIC_AGENT_DEFAULTS", false),
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

  const channels: Record<string, unknown> = { telegram };
  if (cfg.discord) {
    // `guilds` is Discord's `groups`; requireMention keeps the bot quiet in busy
    // servers. Streaming is off for the same reason as Telegram (see above).
    const discord: Record<string, unknown> = {
      enabled: cfg.discord.enabled,
      dmPolicy: cfg.discord.dmPolicy,
      guilds: { "*": { requireMention: true } },
      streaming: { mode: "off" },
    };
    if (cfg.discord.dmPolicy === "allowlist") {
      discord.allowFrom = cfg.discord.allowFrom;
    }
    channels.discord = discord;
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
    channels,
    agents: {
      defaults: {
        model: { primary: `${cfg.provider.openclawProvider}/${cfg.provider.defaultModel}` },
        workspace: cfg.workspaceDir,
        ...(cfg.thinkingDefault ? { thinkingDefault: cfg.thinkingDefault } : {}),
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
  preserveAgentDefaults = false,
): Record<string, unknown> {
  const merged = { ...existing, ...generated };
  if (!preserveAgentDefaults) return merged;

  const existingAgents = existing.agents as Record<string, unknown> | undefined;
  const generatedAgents = generated.agents as Record<string, unknown> | undefined;
  const existingDefaults = existingAgents?.defaults as Record<string, unknown> | undefined;
  const generatedDefaults = generatedAgents?.defaults as Record<string, unknown> | undefined;
  if (!existingDefaults || !generatedDefaults || !generatedAgents) return merged;

  // Preserve runtime-added agent keys (including agents.list and defaults such
  // as concurrency/sandbox), while generated host fields remain authoritative.
  const defaults = { ...existingDefaults, ...generatedDefaults };
  delete defaults.model;
  delete defaults.thinkingDefault;

  // In dynamic mode, valid runtime model/thinking values are authoritative.
  // Invalid legacy/manual values fall back to the validated env-generated
  // defaults so a bad edit cannot make the next gateway boot fail.
  const existingModel = existingDefaults.model;
  if (isValidAgentModelConfig(existingModel)) {
    defaults.model = existingModel;
  } else if (generatedDefaults.model !== undefined) {
    defaults.model = generatedDefaults.model;
  }
  if (
    typeof existingDefaults.thinkingDefault === "string" &&
    VALID_THINKING_LEVELS.includes(existingDefaults.thinkingDefault as ThinkingLevel)
  ) {
    defaults.thinkingDefault = existingDefaults.thinkingDefault;
  } else if (generatedDefaults.thinkingDefault !== undefined) {
    defaults.thinkingDefault = generatedDefaults.thinkingDefault;
  }

  merged.agents = { ...existingAgents, ...generatedAgents, defaults };
  return merged;
}
