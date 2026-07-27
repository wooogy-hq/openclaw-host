/**
 * AI provider resolution — ported from serverless-openclaw
 * (packages/shared/src/provider-config.ts) and extended here to be
 * provider- and model-agnostic with selectable auth (API key vs OAuth).
 *
 * Named providers keep convenient defaults; any other AI_PROVIDER value is
 * treated as a custom OpenAI/Anthropic-compatible backend fully described by
 * env (AI_BASE_URL / AI_OPENCLAW_API / AI_AUTH / AI_MODEL). See
 * docs/superpowers/specs/2026-07-27-provider-agnostic-codex-design.md.
 */

/** How the gateway authenticates to the provider. `oauth` = subscription/OAuth
 *  profile (e.g. OpenClaw's OpenAI device login); `api-key` = provider key from env;
 *  `aws-sdk` = Bedrock via the AWS SDK credential chain. */
export type AuthMode = "api-key" | "oauth" | "aws-sdk";

export interface ProviderConfig {
  /** The AI_PROVIDER value as given (named or custom). */
  provider: string;
  /** Provider id openclaw routes with, e.g. `openai`, `deepseek`, `amazon-bedrock`. */
  openclawProvider: string;
  /** openclaw provider API family (used when emitting a custom models.providers block). */
  openclawApi: string;
  /** Selected auth mode (env AI_AUTH overrides the provider default). */
  authMode: AuthMode;
  defaultModel: string;
  /** Custom base URL for OpenAI/Anthropic-compatible endpoints (env AI_BASE_URL). */
  baseUrl?: string;
}

const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-pro";
const OPENAI_DEFAULT_MODEL = "gpt-5.5";

/** Base Bedrock model ID (without CRIS prefix). */
export const BEDROCK_BASE_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";

// Maps AWS region → cross-region inference system (CRIS) geographic prefix.
const REGION_CRIS_PREFIX: Record<string, string> = {
  // United States
  "us-east-1": "us",
  "us-east-2": "us",
  "us-west-1": "us",
  "us-west-2": "us",
  "ca-central-1": "us",
  "ca-west-1": "us",
  // Europe
  "eu-central-1": "eu",
  "eu-west-1": "eu",
  "eu-west-2": "eu",
  "eu-west-3": "eu",
  "eu-north-1": "eu",
  "eu-south-1": "eu",
  "eu-south-2": "eu",
  // Asia Pacific
  "ap-northeast-1": "apac",
  "ap-northeast-2": "apac",
  "ap-northeast-3": "apac",
  "ap-south-1": "apac",
  "ap-south-2": "apac",
  "ap-southeast-1": "apac",
  "ap-southeast-2": "apac",
  "ap-southeast-3": "apac",
  "ap-southeast-4": "apac",
  "ap-southeast-5": "apac",
  "ap-southeast-7": "apac",
};

interface ProviderDefault {
  openclawProvider: string;
  openclawApi: string;
  defaultAuthMode: AuthMode;
  defaultModel?: string;
}

/** Built-in providers with sane defaults. Unknown names → custom (see resolveProviderConfig). */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefault> = {
  anthropic: {
    openclawProvider: "anthropic",
    openclawApi: "anthropic",
    defaultAuthMode: "api-key",
    defaultModel: "claude-sonnet-4-20250514",
  },
  bedrock: {
    openclawProvider: "amazon-bedrock",
    openclawApi: "bedrock-converse-stream",
    defaultAuthMode: "aws-sdk",
  },
  deepseek: {
    openclawProvider: "deepseek",
    openclawApi: "openai-compat",
    defaultAuthMode: "api-key",
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
  },
  openai: {
    // openclaw's native `openai/*` route runs agent turns through the bundled
    // Codex app-server runtime; default auth is the ChatGPT-subscription OAuth
    // profile created by `openclaw models auth login --provider openai
    // --device-code`. Set AI_AUTH=key for OpenAI Platform API-key auth.
    openclawProvider: "openai",
    openclawApi: "openai-responses",
    defaultAuthMode: "oauth",
    defaultModel: OPENAI_DEFAULT_MODEL,
  },
};

/** Custom (unknown) providers default to an OpenAI-compatible endpoint. */
const CUSTOM_DEFAULT_API = "openai-completions";

function parseAuthMode(value: string | undefined, fallback: AuthMode): AuthMode {
  if (value === undefined || value === "") return fallback;
  const v = value.toLowerCase();
  if (v === "key" || v === "api-key" || v === "apikey") return "api-key";
  if (v === "oauth") return "oauth";
  if (v === "aws-sdk" || v === "aws") return "aws-sdk";
  throw new Error(`Invalid AI_AUTH: '${value}'. Valid values: key, oauth, aws-sdk`);
}

/**
 * CRIS geographic prefix for a region, or undefined if unsupported.
 */
export function resolveCrisPrefix(region?: string): string | undefined {
  if (!region) return undefined;
  return REGION_CRIS_PREFIX[region];
}

/**
 * Resolves the Bedrock model ID:
 * - explicit aiModel wins as-is
 * - otherwise prepend the region's CRIS prefix
 * - fall back to the base model ID for regions without CRIS support
 */
export function resolveBedrockModel(region?: string, aiModel?: string): string {
  if (aiModel) return aiModel;
  const prefix = resolveCrisPrefix(region);
  return prefix ? `${prefix}.${BEDROCK_BASE_MODEL}` : BEDROCK_BASE_MODEL;
}

export function resolveProviderConfig(env?: {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_AUTH?: string;
  AI_BASE_URL?: string;
  AI_OPENCLAW_API?: string;
  AWS_REGION?: string;
}): ProviderConfig {
  const resolved = env ?? process.env;
  const provider = (resolved.AI_PROVIDER ?? "anthropic").trim();
  if (provider === "") {
    throw new Error("AI_PROVIDER must not be empty");
  }

  const known = PROVIDER_DEFAULTS[provider];

  if (known) {
    const authMode = parseAuthMode(resolved.AI_AUTH, known.defaultAuthMode);
    const defaultModel =
      provider === "bedrock"
        ? resolveBedrockModel(resolved.AWS_REGION, resolved.AI_MODEL)
        : resolved.AI_MODEL || (known.defaultModel as string);
    return {
      provider,
      openclawProvider: known.openclawProvider,
      openclawApi: known.openclawApi,
      authMode,
      defaultModel,
      baseUrl: resolved.AI_BASE_URL || undefined,
    };
  }

  // Custom provider: fully env-described OpenAI/Anthropic-compatible backend.
  if (!resolved.AI_MODEL) {
    throw new Error(`Custom AI_PROVIDER '${provider}' requires AI_MODEL to be set`);
  }
  return {
    provider,
    openclawProvider: provider,
    openclawApi: resolved.AI_OPENCLAW_API || CUSTOM_DEFAULT_API,
    authMode: parseAuthMode(resolved.AI_AUTH, "api-key"),
    defaultModel: resolved.AI_MODEL,
    baseUrl: resolved.AI_BASE_URL || undefined,
  };
}
