import { describe, it, expect } from "vitest";
import {
  parseVersion,
  capabilitiesFor,
  applyCompat,
  type Capabilities,
} from "../src/openclaw-compat.js";

const OLD = capabilitiesFor(parseVersion("OpenClaw 2026.7.1-2 (0790d9f)"));
const NEW = capabilitiesFor(parseVersion("OpenClaw 2026.9.2 (3928bad)"));

/** The roster/defaults slice of this host's real config, as 2026.7.1-2 left it. */
function liveConfig(): Record<string, unknown> {
  return {
    meta: { lastTouchedVersion: "2026.7.1-2", lastTouchedAt: "2026-09-05T14:20:01.186Z" },
    plugins: { allow: ["codex", "openai"], bundledDiscovery: "compat" },
    agents: {
      defaults: {
        workspace: "/data/workspace",
        models: { "openai/gpt-5.6-sol": {} },
        model: "openai/gpt-5.6-sol",
        thinkingDefault: "xhigh",
      },
      list: [
        { id: "main" },
        {
          id: "work",
          name: "work",
          workspace: "/data/workspace-work",
          groupChat: { visibleReplies: "message_tool" },
        },
        { id: "ga-analysis", name: "GA analysis", groupChat: { visibleReplies: "message_tool" } },
      ],
    },
  };
}

describe("parseVersion", () => {
  it("reads the triple out of the CLI banner", () => {
    expect(parseVersion("OpenClaw 2026.9.2 (3928bad)")).toEqual([2026, 9, 2]);
  });

  it("ignores build and prerelease suffixes, which carry no ordering we need", () => {
    expect(parseVersion("OpenClaw 2026.7.1-2 (0790d9f)")).toEqual([2026, 7, 1]);
    expect(parseVersion("OpenClaw 2026.9.1-beta.1")).toEqual([2026, 9, 1]);
  });

  it("returns undefined rather than a wrong guess when there is no version", () => {
    expect(parseVersion("command not found")).toBeUndefined();
  });
});

describe("capabilitiesFor", () => {
  it("splits at 2026.8.1", () => {
    expect(capabilitiesFor([2026, 8, 0]).rosterKey).toBe("list");
    expect(capabilitiesFor([2026, 8, 1]).rosterKey).toBe("entries");
    expect(capabilitiesFor([2026, 9, 2]).rosterKey).toBe("entries");
  });

  it("orders by month before patch, so 2026.6.34 stays old", () => {
    expect(capabilitiesFor(parseVersion("2026.6.34")).rosterKey).toBe("list");
  });

  it("assumes the OLD shape when the version is unknown", () => {
    // Deliberate: a new gateway repairs an old-shaped config, but an old gateway
    // refuses to start on a new-shaped one. Only one guess is recoverable
    // unattended.
    expect(capabilitiesFor(undefined).rosterKey).toBe("list");
    expect(capabilitiesFor(undefined).sessionsInSqlite).toBe(false);
  });
});

describe("applyCompat → 2026.8.1+", () => {
  it("keys the roster by id and keeps every field but the id", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    const agents = cfg.agents as Record<string, any>;
    expect(agents.list).toBeUndefined();
    expect(Object.keys(agents.entries)).toEqual(["main", "work", "ga-analysis"]);
    expect(agents.entries.work).toMatchObject({
      name: "work",
      workspace: "/data/workspace-work",
    });
    expect(agents.entries.work.id).toBeUndefined();
  });

  it("stamps ownership on a fleet", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    expect((cfg.agents as any).ownership).toBe("explicit");
  });

  it("leaves a sole agent unstamped, as the upstream key documents", () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    applyCompat(cfg, NEW);
    expect((cfg.agents as any).ownership).toBeUndefined();
  });

  it("moves model restrictions to modelPolicy.allow", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    const defaults = (cfg.agents as any).defaults;
    expect(defaults.models).toBeUndefined();
    expect(defaults.modelPolicy).toEqual({ allow: ["openai/gpt-5.6-sol"] });
    expect(defaults.model).toBe("openai/gpt-5.6-sol"); // the alias is not a restriction
  });

  it("hoists visibleReplies to the global key and drops the emptied groupChat", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    expect((cfg.messages as any).groupChat.visibleReplies).toBe("message_tool");
    expect((cfg.agents as any).entries.work.groupChat).toBeUndefined();
  });

  it("clears the keys an older gateway wrote and this one rejects", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    expect((cfg.meta as any).lastTouchedAt).toBeUndefined();
    expect((cfg.meta as any).lastTouchedVersion).toBe("2026.7.1-2"); // sibling untouched
    expect((cfg.plugins as any).bundledDiscovery).toBeUndefined();
    expect((cfg.plugins as any).allow).toEqual(["codex", "openai"]);
  });

  it("is idempotent", () => {
    const once = liveConfig();
    applyCompat(once, NEW);
    const snapshot = JSON.parse(JSON.stringify(once));
    const changes = applyCompat(once, NEW);
    expect(changes).toEqual([]);
    expect(once).toEqual(snapshot);
  });
});

describe("applyCompat → back to 2026.7.x", () => {
  it("converts entries back to a list so an older gateway can read it", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    applyCompat(cfg, OLD);
    const agents = cfg.agents as Record<string, any>;
    expect(agents.entries).toBeUndefined();
    expect(agents.list.map((a: any) => a.id)).toEqual(["main", "work", "ga-analysis"]);
    expect(agents.list[1]).toMatchObject({ id: "work", workspace: "/data/workspace-work" });
  });

  it("drops the ownership marker and modelPolicy, which older gateways reject", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    applyCompat(cfg, OLD);
    expect((cfg.agents as any).ownership).toBeUndefined();
    expect((cfg.agents as any).defaults.modelPolicy).toBeUndefined();
    expect((cfg.agents as any).defaults.models).toEqual({ "openai/gpt-5.6-sol": {} });
  });

  it("leaves visibleReplies global — both versions accept it there", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    applyCompat(cfg, OLD);
    expect((cfg.messages as any).groupChat.visibleReplies).toBe("message_tool");
  });

  it("survives a full round trip with the roster intact", () => {
    const cfg = liveConfig();
    applyCompat(cfg, NEW);
    applyCompat(cfg, OLD);
    applyCompat(cfg, NEW);
    expect(Object.keys((cfg.agents as any).entries)).toEqual(["main", "work", "ga-analysis"]);
  });
});

describe("applyCompat safety", () => {
  it("does nothing to a config with no agents block", () => {
    const cfg = { gateway: { port: 18789 } };
    expect(applyCompat(cfg, NEW)).toEqual([]);
    expect(cfg).toEqual({ gateway: { port: 18789 } });
  });

  it("skips roster entries with no usable id instead of inventing one", () => {
    const cfg = { agents: { list: [{ id: "main" }, { name: "orphan" }, { id: "" }] } };
    applyCompat(cfg, NEW);
    expect(Object.keys((cfg.agents as any).entries)).toEqual(["main"]);
  });

  it("reports every change it makes", () => {
    const changes = applyCompat(liveConfig(), NEW);
    expect(changes.join("\n")).toMatch(/agents\.list → agents\.entries/);
    expect(changes.join("\n")).toMatch(/ownership/);
    expect(changes.join("\n")).toMatch(/visibleReplies/);
    expect(changes.join("\n")).toMatch(/retired meta\.lastTouchedAt/);
  });
});

describe("memorySearch moved out of agents.defaults", () => {
  const withSearch = () => ({
    agents: {
      defaults: { workspace: "/data/ws", memorySearch: { enabled: false } },
      list: [{ id: "main" }, { id: "work", memorySearch: { enabled: true } }],
    },
    memory: { citations: "auto" },
  });

  it("hangs the global toggle off memory.search on 2026.8.1+", () => {
    const cfg = withSearch();
    applyCompat(cfg, NEW);
    expect((cfg.memory as any).search).toEqual({ enabled: false });
    expect((cfg.agents as any).defaults.memorySearch).toBeUndefined();
    expect((cfg.memory as any).citations).toBe("auto"); // sibling kept
  });

  it("moves a per-agent override under that agent's memory.search", () => {
    const cfg = withSearch();
    applyCompat(cfg, NEW);
    expect((cfg.agents as any).entries.work.memory.search).toEqual({ enabled: true });
    expect((cfg.agents as any).entries.work.memorySearch).toBeUndefined();
  });

  it("puts both back for an older gateway", () => {
    const cfg = withSearch();
    applyCompat(cfg, NEW);
    applyCompat(cfg, OLD);
    expect((cfg.agents as any).defaults.memorySearch).toEqual({ enabled: false });
    expect((cfg.memory as any).search).toBeUndefined();
    const work = (cfg.agents as any).list.find((a: any) => a.id === "work");
    expect(work.memorySearch).toEqual({ enabled: true });
  });

  it("is idempotent in both directions", () => {
    const cfg = withSearch();
    applyCompat(cfg, NEW);
    expect(applyCompat(cfg, NEW)).toEqual([]);
    applyCompat(cfg, OLD);
    expect(applyCompat(cfg, OLD)).toEqual([]);
  });
});
