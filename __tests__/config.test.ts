import { describe, it, expect } from "vitest";
import { loadConfig, buildOpenclawConfig, mergeOpenclawConfig } from "../src/config.js";

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
    expect(cfg.restoreOnStart).toBe(true);
    expect(cfg.telegram.enabled).toBe(true);
    expect(cfg.telegram.dmPolicy).toBe("pairing");
    expect(cfg.provider.provider).toBe("anthropic");
  });

  it("allows startup restore to be disabled explicitly", () => {
    expect(loadConfig({ ...base, RESTORE_ON_START: "false" }).restoreOnStart).toBe(false);
  });

  it("rejects an invalid RESTORE_ON_START value", () => {
    expect(() => loadConfig({ ...base, RESTORE_ON_START: "sometimes" })).toThrow(
      /RESTORE_ON_START/,
    );
  });

  it("loads and validates the default thinking effort", () => {
    expect(loadConfig({ ...base, AI_THINKING: "xhigh" }).thinkingDefault).toBe("xhigh");
    expect(loadConfig({ ...base }).thinkingDefault).toBeUndefined();
    expect(() => loadConfig({ ...base, AI_THINKING: "extreme" })).toThrow(/AI_THINKING/);
  });

  it("can enable runtime-persistent agent defaults", () => {
    expect(loadConfig({ ...base }).dynamicAgentDefaults).toBe(false);
    expect(
      loadConfig({ ...base, DYNAMIC_AGENT_DEFAULTS: "true" }).dynamicAgentDefaults,
    ).toBe(true);
  });

  it("reads the OpenClaw state dir (OPENCLAW_STATE_DIR) with a default", () => {
    expect(loadConfig({ ...base }).stateDir).toBe("./.openclaw");
    expect(loadConfig({ ...base, OPENCLAW_STATE_DIR: "/data/oc" }).stateDir).toBe("/data/oc");
  });

  it("reads the gateway token from env (empty when unset; index.ts persists one)", () => {
    expect(loadConfig({ ...base }).gatewayToken).toBe("");
    expect(loadConfig({ ...base, OPENCLAW_GATEWAY_TOKEN: "secret-tok" }).gatewayToken).toBe(
      "secret-tok",
    );
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
    // Streaming off → one final message per turn (avoids repeated-message bug).
    // Object form — openclaw 2026.6.x requires {mode} and rejects the string.
    expect(tg.streaming).toEqual({ mode: "off" });
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

  it("writes gateway.auth.token when a token is set (so cron/agent can authenticate)", () => {
    const json = buildOpenclawConfig(loadConfig({ ...base, OPENCLAW_GATEWAY_TOKEN: "tok-123" }));
    expect((json.gateway as any).auth).toEqual({ mode: "token", token: "tok-123" });
  });

  it("omits gateway.auth when no token is set", () => {
    const json = buildOpenclawConfig(loadConfig({ ...base }));
    expect((json.gateway as any).auth).toBeUndefined();
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

  it("sets the default agent thinking effort when configured", () => {
    const json = buildOpenclawConfig(
      loadConfig({ ...base, AI_PROVIDER: "openai", AI_THINKING: "xhigh" }),
    );
    expect((json.agents as any).defaults.thinkingDefault).toBe("xhigh");
  });

  it("maps a bedrock provider into the model primary", () => {
    const json = buildOpenclawConfig(
      loadConfig({ ...base, AI_PROVIDER: "bedrock", AWS_REGION: "ap-northeast-2" }),
    );
    expect((json.agents as any).defaults.model.primary).toBe(
      "amazon-bedrock/apac.anthropic.claude-sonnet-4-20250514-v1:0",
    );
  });

  it("maps an openai provider (Codex subscription) into the model primary with no custom block", () => {
    const json = buildOpenclawConfig(loadConfig({ ...base, AI_PROVIDER: "openai" }));
    expect((json.agents as any).defaults.model.primary).toBe("openai/gpt-5.5");
    // openclaw's native openai route has a built-in endpoint → no models.providers needed
    expect(json.models).toBeUndefined();
  });

  it("emits a models.providers block for a custom base URL (api-key) without leaking the key", () => {
    const json = buildOpenclawConfig(
      loadConfig({
        ...base,
        AI_PROVIDER: "litellm",
        AI_BASE_URL: "http://litellm:4000/v1",
        AI_MODEL: "gpt-4o",
        AI_API_KEY: "sk-secret-should-not-appear",
      }),
    );
    expect((json.agents as any).defaults.model.primary).toBe("litellm/gpt-4o");
    const p = (json.models as any).providers.litellm;
    expect(p.baseUrl).toBe("http://litellm:4000/v1");
    expect(p.api).toBe("openai-completions");
    expect(p.apiKey).toBe("${AI_API_KEY}");
    // the actual secret must never be inlined into openclaw.json
    expect(JSON.stringify(json)).not.toContain("sk-secret-should-not-appear");
  });

  it("omits apiKey for a custom oauth backend", () => {
    const json = buildOpenclawConfig(
      loadConfig({
        ...base,
        AI_PROVIDER: "my-proxy",
        AI_BASE_URL: "http://proxy:8080",
        AI_AUTH: "oauth",
        AI_MODEL: "m1",
      }),
    );
    expect((json.models as any).providers["my-proxy"].apiKey).toBeUndefined();
  });
});

describe("mergeOpenclawConfig", () => {
  it("preserves runtime-added top-level keys (mcp) while host keys stay authoritative", () => {
    const existing = {
      gateway: { port: 1, mode: "local", auth: { mode: "token", token: "OLD" } },
      channels: { telegram: { enabled: false } },
      mcp: { servers: { "risk-radar": { url: "http://risk-radar-mcp:8765/mcp" } } },
      meta: { lastTouchedAt: "x" },
    };
    const generated = buildOpenclawConfig(loadConfig({ ...base, OPENCLAW_GATEWAY_TOKEN: "NEW" }));
    const merged = mergeOpenclawConfig(existing, generated);
    // runtime keys survive the rewrite
    expect((merged.mcp as any).servers["risk-radar"]).toBeDefined();
    expect(merged.meta).toEqual({ lastTouchedAt: "x" });
    // host-managed keys are replaced by the freshly generated ones
    expect((merged.gateway as any).auth.token).toBe("NEW");
    expect((merged.channels as any).telegram.enabled).toBe(true);
  });

  it("preserves runtime model and thinking defaults when dynamic defaults are enabled", () => {
    const existing = {
      agents: {
        list: [{ id: "main", name: "Main" }],
        defaults: {
          model: { primary: "openai/gpt-5.6-terra" },
          thinkingDefault: "ultra",
          maxConcurrent: 99,
        },
      },
    };
    const generated = buildOpenclawConfig(
      loadConfig({
        ...base,
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-5.6-sol",
        AI_THINKING: "xhigh",
      }),
    );
    const merged = mergeOpenclawConfig(existing, generated, true);
    const defaults = (merged.agents as any).defaults;
    expect(defaults.model.primary).toBe("openai/gpt-5.6-terra");
    expect(defaults.thinkingDefault).toBe("ultra");
    expect(defaults.workspace).toBe("./data/workspace");
    expect(defaults.maxConcurrent).toBe(99);
    expect((merged.agents as any).list).toEqual([{ id: "main", name: "Main" }]);
  });

  it("falls back to env-generated defaults when existing dynamic values are malformed", () => {
    const existing = {
      agents: {
        defaults: {
          model: { primary: "" },
          thinkingDefault: "extreme",
        },
      },
    };
    const generated = buildOpenclawConfig(
      loadConfig({
        ...base,
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-5.6-sol",
        AI_THINKING: "xhigh",
      }),
    );
    const merged = mergeOpenclawConfig(existing, generated, true);
    const defaults = (merged.agents as any).defaults;
    expect(defaults.model.primary).toBe("openai/gpt-5.6-sol");
    expect(defaults.thinkingDefault).toBe("xhigh");
  });

  it("preserves the valid string form of a runtime model override", () => {
    const existing = {
      agents: {
        defaults: {
          model: "openai/gpt-5.6-terra",
        },
      },
    };
    const generated = buildOpenclawConfig(
      loadConfig({ ...base, AI_PROVIDER: "openai", AI_MODEL: "gpt-5.6-sol" }),
    );
    const merged = mergeOpenclawConfig(existing, generated, true);
    expect((merged.agents as any).defaults.model).toBe("openai/gpt-5.6-terra");
  });

  it("removes malformed thinking when no env fallback is configured", () => {
    const existing = {
      agents: {
        defaults: {
          thinkingDefault: "extreme",
        },
      },
    };
    const generated = buildOpenclawConfig(
      loadConfig({ ...base, AI_PROVIDER: "openai" }),
    );
    const merged = mergeOpenclawConfig(existing, generated, true);
    expect((merged.agents as any).defaults.thinkingDefault).toBeUndefined();
  });

  it("rejects malformed runtime model objects and uses the env fallback", () => {
    const generated = buildOpenclawConfig(
      loadConfig({ ...base, AI_PROVIDER: "openai", AI_MODEL: "gpt-5.6-sol" }),
    );
    for (const model of [
      { primary: "openai/gpt-5.6-terra", fallbacks: 123 },
      { primary: "openai/gpt-5.6-terra", timeoutMs: -1 },
      { primary: "openai/gpt-5.6-terra", unknown: true },
    ]) {
      const merged = mergeOpenclawConfig(
        { agents: { defaults: { model } } },
        generated,
        true,
      );
      expect((merged.agents as any).defaults.model.primary).toBe("openai/gpt-5.6-sol");
    }
  });
});

describe("discord channel (opt-in second channel)", () => {
  const base = {
    DATA_BUCKET: "b",
    USER_ID: "u",
    TELEGRAM_BOT_TOKEN: "t",
  };

  it("emits no discord channel when DISCORD_BOT_TOKEN is unset", () => {
    const cfg = loadConfig(base);
    expect(cfg.discord).toBeUndefined();
    const obj = buildOpenclawConfig(cfg);
    expect(Object.keys(obj.channels as object)).toEqual(["telegram"]);
  });

  it("emits discord from env so it survives the per-boot channels rewrite", () => {
    const cfg = loadConfig({ ...base, DISCORD_BOT_TOKEN: "d", DISCORD_ALLOW_FROM: "42" });
    const discord = (buildOpenclawConfig(cfg).channels as any).discord;
    expect(discord).toEqual({
      enabled: true,
      dmPolicy: "allowlist",
      allowFrom: ["42"],
      guilds: { "*": { requireMention: true } },
      streaming: { mode: "off" },
    });
  });

  it("leaves the telegram channel untouched when discord is added", () => {
    const withDiscord = buildOpenclawConfig(
      loadConfig({ ...base, DISCORD_BOT_TOKEN: "d", DISCORD_ALLOW_FROM: "42" }),
    );
    const withoutDiscord = buildOpenclawConfig(loadConfig(base));
    expect((withDiscord.channels as any).telegram).toEqual(
      (withoutDiscord.channels as any).telegram,
    );
  });

  it("rejects an allowlist policy with no ids, like telegram does", () => {
    expect(() => loadConfig({ ...base, DISCORD_BOT_TOKEN: "d" })).toThrow(/DISCORD_ALLOW_FROM/);
  });
});
