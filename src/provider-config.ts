/**
 * AI provider resolution — ported from serverless-openclaw
 * (packages/shared/src/provider-config.ts). Kept behaviourally identical so
 * the openclaw.json this host writes matches what the serverless side writes.
 */

export type AiProvider = "anthropic" | "bedrock" | "deepseek";

export interface ProviderConfig {
  provider: AiProvider;
  openclawProvider: string;
  openclawApi: string;
  openclawAuth: string;
  defaultModel: string;
  /** Override Anthropic SDK base URL (for Anthropic-compatible third parties like DeepSeek). */
  baseUrl?: string;
}

const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-pro";

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

export const PROVIDER_DEFAULTS = {
  anthropic: {
    openclawProvider: "anthropic",
    openclawApi: "anthropic",
    openclawAuth: "api-key",
    defaultModel: "claude-sonnet-4-20250514",
  },
  bedrock: {
    openclawProvider: "amazon-bedrock",
    openclawApi: "bedrock-converse-stream",
    openclawAuth: "aws-sdk",
  },
  deepseek: {
    openclawProvider: "deepseek",
    openclawApi: "openai-compat",
    openclawAuth: "api-key",
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
  },
} as const;

const VALID_PROVIDERS: readonly string[] = ["anthropic", "bedrock", "deepseek"];

export function validateProvider(value: string): asserts value is AiProvider {
  if (!VALID_PROVIDERS.includes(value)) {
    throw new Error(
      `Unsupported AI_PROVIDER: '${value}'. Valid values: ${VALID_PROVIDERS.join(", ")}`,
    );
  }
}

/** CRIS geographic prefix for a region, or undefined if unsupported. */
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

export function resolveModel(provider: "anthropic" | "deepseek", aiModel?: string): string {
  return aiModel || PROVIDER_DEFAULTS[provider].defaultModel;
}

export function resolveProviderConfig(env?: {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AWS_REGION?: string;
}): ProviderConfig {
  const resolved = env ?? process.env;
  const raw = resolved.AI_PROVIDER ?? "anthropic";
  validateProvider(raw);

  const defaults = PROVIDER_DEFAULTS[raw];

  const defaultModel =
    raw === "bedrock"
      ? resolveBedrockModel(resolved.AWS_REGION, resolved.AI_MODEL)
      : resolveModel(raw, resolved.AI_MODEL);

  return {
    provider: raw,
    openclawProvider: defaults.openclawProvider,
    openclawApi: defaults.openclawApi,
    openclawAuth: defaults.openclawAuth,
    defaultModel,
  };
}
