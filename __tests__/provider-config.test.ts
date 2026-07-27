import { describe, it, expect } from "vitest";
import { resolveProviderConfig, resolveBedrockModel } from "../src/provider-config.js";

describe("resolveProviderConfig", () => {
  it("defaults to anthropic (api-key) when AI_PROVIDER is unset", () => {
    const cfg = resolveProviderConfig({});
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.openclawProvider).toBe("anthropic");
    expect(cfg.openclawApi).toBe("anthropic");
    expect(cfg.authMode).toBe("api-key");
    expect(cfg.defaultModel).toBe("claude-sonnet-4-20250514");
    expect(cfg.baseUrl).toBeUndefined();
  });

  it("honours an explicit anthropic AI_MODEL override", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "anthropic", AI_MODEL: "claude-opus-4" });
    expect(cfg.defaultModel).toBe("claude-opus-4");
  });

  it("resolves a deepseek config", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "deepseek" });
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.openclawProvider).toBe("deepseek");
    expect(cfg.openclawApi).toBe("openai-compat");
    expect(cfg.authMode).toBe("api-key");
    expect(cfg.defaultModel).toBe("deepseek-v4-pro");
  });

  it("resolves openai with a Codex-subscription OAuth default", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "openai" });
    expect(cfg.provider).toBe("openai");
    expect(cfg.openclawProvider).toBe("openai");
    expect(cfg.authMode).toBe("oauth");
    expect(cfg.defaultModel).toBe("gpt-5.5");
  });

  it("lets AI_AUTH=key flip openai to API-key auth", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "openai", AI_AUTH: "key" });
    expect(cfg.authMode).toBe("api-key");
  });

  it("honours an openai AI_MODEL override (model-agnostic)", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "openai", AI_MODEL: "gpt-5-codex" });
    expect(cfg.defaultModel).toBe("gpt-5-codex");
  });

  it("derives a CRIS-prefixed bedrock model from the AWS region", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "bedrock", AWS_REGION: "ap-northeast-2" });
    expect(cfg.openclawProvider).toBe("amazon-bedrock");
    expect(cfg.authMode).toBe("aws-sdk");
    expect(cfg.defaultModel).toBe("apac.anthropic.claude-sonnet-4-20250514-v1:0");
  });

  it("falls back to the base bedrock model for regions without CRIS", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "bedrock", AWS_REGION: "sa-east-1" });
    expect(cfg.defaultModel).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
  });

  it("lets an explicit AI_MODEL override the bedrock region derivation", () => {
    const cfg = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "us-east-1",
      AI_MODEL: "us.anthropic.custom",
    });
    expect(cfg.defaultModel).toBe("us.anthropic.custom");
  });

  it("treats an unknown provider as a custom openai-compatible backend", () => {
    const cfg = resolveProviderConfig({
      AI_PROVIDER: "litellm",
      AI_BASE_URL: "http://localhost:4000/v1",
      AI_MODEL: "gpt-4o",
    });
    expect(cfg.provider).toBe("litellm");
    expect(cfg.openclawProvider).toBe("litellm");
    expect(cfg.openclawApi).toBe("openai-completions");
    expect(cfg.authMode).toBe("api-key");
    expect(cfg.baseUrl).toBe("http://localhost:4000/v1");
    expect(cfg.defaultModel).toBe("gpt-4o");
  });

  it("lets a custom provider pick the anthropic-compatible API and oauth", () => {
    const cfg = resolveProviderConfig({
      AI_PROVIDER: "my-proxy",
      AI_BASE_URL: "http://proxy:8080",
      AI_OPENCLAW_API: "anthropic-messages",
      AI_AUTH: "oauth",
      AI_MODEL: "some-model",
    });
    expect(cfg.openclawApi).toBe("anthropic-messages");
    expect(cfg.authMode).toBe("oauth");
  });

  it("requires AI_MODEL for a custom provider", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "litellm", AI_BASE_URL: "http://x" })).toThrow(
      /requires AI_MODEL/,
    );
  });

  it("rejects an empty AI_PROVIDER", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "  " })).toThrow(/must not be empty/);
  });

  it("rejects an invalid AI_AUTH value", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "openai", AI_AUTH: "nope" })).toThrow(
      /Invalid AI_AUTH/,
    );
  });
});

describe("resolveBedrockModel", () => {
  it("prefixes eu regions", () => {
    expect(resolveBedrockModel("eu-west-1")).toBe("eu.anthropic.claude-sonnet-4-20250514-v1:0");
  });
  it("returns the explicit model untouched", () => {
    expect(resolveBedrockModel("us-east-1", "foo")).toBe("foo");
  });
});
