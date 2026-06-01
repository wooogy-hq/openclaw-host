import { describe, it, expect } from "vitest";
import { loadConfig, buildOpenclawConfig } from "../src/config.js";

const base = {
  DATA_BUCKET: "my-bucket",
  USER_ID: "u1",
  TELEGRAM_BOT_TOKEN: "123:abc",
};

describe("loadConfig", () => {
  it("loads required + default values", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.dataBucket).toBe("my-bucket");
    expect(cfg.userId).toBe("u1");
    expect(cfg.gatewayPort).toBe(18789);
    expect(cfg.backupIntervalMs).toBe(120000);
    expect(cfg.telegram.enabled).toBe(true);
    expect(cfg.telegram.dmPolicy).toBe("pairing");
    expect(cfg.provider.provider).toBe("anthropic");
  });

  it("reads the OpenClaw state dir (OPENCLAW_STATE_DIR) with a default", () => {
    expect(loadConfig({ ...base }).stateDir).toBe("./.openclaw");
    expect(loadConfig({ ...base, OPENCLAW_STATE_DIR: "/data/oc" }).stateDir).toBe("/data/oc");
  });

  it("throws when DATA_BUCKET is missing", () => {
    expect(() => loadConfig({ USER_ID: "u1", TELEGRAM_BOT_TOKEN: "t" })).toThrow(/DATA_BUCKET/);
  });

  it("throws when USER_ID is missing", () => {
    expect(() => loadConfig({ DATA_BUCKET: "b", TELEGRAM_BOT_TOKEN: "t" })).toThrow(/USER_ID/);
  });

  it("requires a Telegram bot token (v1 channel)", () => {
    expect(() => loadConfig({ DATA_BUCKET: "b", USER_ID: "u1" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("parses a comma-separated allowFrom list", () => {
    const cfg = loadConfig({ ...base, TELEGRAM_DM_POLICY: "allowlist", TELEGRAM_ALLOW_FROM: "111, 222" });
    expect(cfg.telegram.dmPolicy).toBe("allowlist");
    expect(cfg.telegram.allowFrom).toEqual(["111", "222"]);
  });

  it("rejects allowlist policy with an empty allowFrom (mirrors OpenClaw validation)", () => {
    expect(() => loadConfig({ ...base, TELEGRAM_DM_POLICY: "allowlist" })).toThrow(
      /TELEGRAM_ALLOW_FROM/,
    );
  });

  it("rejects an invalid dmPolicy", () => {
    expect(() => loadConfig({ ...base, TELEGRAM_DM_POLICY: "wat" })).toThrow(/TELEGRAM_DM_POLICY/);
  });
});

describe("buildOpenclawConfig", () => {
  it("enables the telegram channel without writing the bot token to disk", () => {
    const json = buildOpenclawConfig(loadConfig({ ...base }));
    const tg = (json.channels as any).telegram;
    expect(tg.enabled).toBe(true);
    expect(tg.dmPolicy).toBe("pairing");
    expect(tg.groups).toEqual({ "*": { requireMention: true } });
    // Security: the secret must never land in openclaw.json.
    expect(tg.botToken).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("123:abc");
  });

  it("includes allowFrom only in allowlist mode", () => {
    const json = buildOpenclawConfig(
      loadConfig({ ...base, TELEGRAM_DM_POLICY: "allowlist", TELEGRAM_ALLOW_FROM: "111" }),
    );
    expect((json.channels as any).telegram.allowFrom).toEqual(["111"]);
  });

  it("sets the gateway port and agent model/workspace", () => {
    const json = buildOpenclawConfig(
      loadConfig({ ...base, AI_PROVIDER: "anthropic", WORKSPACE_DIR: "/data/ws" }),
    );
    expect((json.gateway as any).port).toBe(18789);
    const defaults = (json.agents as any).defaults;
    expect(defaults.model.primary).toBe("anthropic/claude-sonnet-4-20250514");
    expect(defaults.workspace).toBe("/data/ws");
  });

  it("maps a bedrock provider into the model primary", () => {
    const json = buildOpenclawConfig(
      loadConfig({ ...base, AI_PROVIDER: "bedrock", AWS_REGION: "ap-northeast-2" }),
    );
    expect((json.agents as any).defaults.model.primary).toBe(
      "amazon-bedrock/apac.anthropic.claude-sonnet-4-20250514-v1:0",
    );
  });
});
