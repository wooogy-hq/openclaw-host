import { describe, it, expect } from "vitest";
import {
  resolveProviderConfig,
  resolveBedrockModel,
  validateProvider,
} from "../src/provider-config.js";

describe("resolveProviderConfig", () => {
  it("defaults to anthropic when AI_PROVIDER is unset", () => {
    const cfg = resolveProviderConfig({});
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.openclawProvider).toBe("anthropic");
    expect(cfg.openclawApi).toBe("anthropic");
    expect(cfg.openclawAuth).toBe("api-key");
    expect(cfg.defaultModel).toBe("claude-sonnet-4-20250514");
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
    expect(cfg.defaultModel).toBe("deepseek-v4-pro");
  });

  it("derives a CRIS-prefixed bedrock model from the AWS region", () => {
    const cfg = resolveProviderConfig({ AI_PROVIDER: "bedrock", AWS_REGION: "ap-northeast-2" });
    expect(cfg.openclawProvider).toBe("amazon-bedrock");
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

  it("throws on an unsupported provider", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "openai" })).toThrow(/Unsupported AI_PROVIDER/);
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

describe("validateProvider", () => {
  it("accepts valid providers", () => {
    expect(() => validateProvider("bedrock")).not.toThrow();
  });
  it("rejects invalid providers", () => {
    expect(() => validateProvider("nope")).toThrow();
  });
});
