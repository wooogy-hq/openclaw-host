/**
 * Config-shape compatibility across OpenClaw versions.
 *
 * openclaw-host rewrites openclaw.json on every boot, so it decides the shape
 * the gateway is handed. OpenClaw 2026.8.1 (marketed as "2.0") changed that
 * shape in ways that are hard errors in BOTH directions: 2026.7.x refuses
 * `agents.entries`, 2026.8.1+ refuses `agents.list`. A host that emits one fixed
 * shape therefore works on exactly one side of that line, and a version bump or
 * a rollback turns into a gateway that will not start.
 *
 * So: detect what is actually installed and emit the shape it accepts. One
 * image stays usable against an older pinned gateway, a current one, and a
 * rollback between them.
 *
 * Only genuine incompatibilities live here. Several settings that look
 * version-specific are accepted by both and are deliberately absent:
 * `messages.groupChat.visibleReplies`, `tools.sessions`, `tools.agentToAgent`.
 * Verified against the `openclaw config schema` output of 2026.7.1-2 and
 * 2026.9.2.
 */

export type Version = readonly [number, number, number];

/** 2026.8.1 — renamed the agent roster, added the ownership marker, and began
 *  rejecting keys earlier releases wrote themselves. */
const ROSTER_RENAME: Version = [2026, 8, 1];

/**
 * Keys OpenClaw 2026.7.x writes into its own config and 2026.8.1+ rejects
 * outright. Nothing here is ours; we only clear them so a config written by an
 * older gateway can still be handed to a newer one.
 */
const RETIRED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["meta", "lastTouchedAt"],
  ["plugins", "bundledDiscovery"],
];

export interface Capabilities {
  /** Parsed `openclaw --version`, or undefined when it could not be read. */
  version?: Version;
  /** Which key holds the agent roster. */
  rosterKey: "list" | "entries";
  /** Multi-agent rosters need `agents.ownership` or ambient callers fail closed. */
  ownershipMarker: boolean;
  /** Model restrictions live in `modelPolicy.allow` rather than `defaults.models`. */
  modelPolicy: boolean;
  /** Config keys in RETIRED_KEYS are hard validation errors. */
  rejectsRetiredKeys: boolean;
  /** Transcripts live in `agents/<id>/agent/openclaw-agent.sqlite`, not
   *  `agents/<id>/sessions/*.jsonl`. Changes what a state backup must copy. */
  sessionsInSqlite: boolean;
  /** Discord and Codex ship as external plugins rather than bundled. */
  externalChannelPlugins: boolean;
}

/**
 * `openclaw --version` prints e.g. "OpenClaw 2026.9.2 (3928bad)". Build suffixes
 * (2026.7.1-2, 2026.9.1-beta.1) carry no ordering this needs, so the numeric
 * triple is the whole comparison.
 */
export function parseVersion(text: string): Version | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export function capabilitiesFor(version: Version | undefined): Capabilities {
  // Unknown version falls back to the older shape on purpose. Guessing "old"
  // yields a config a new gateway repairs on its own; guessing "new" yields one
  // an old gateway refuses to start on. Only one of those is recoverable
  // without a human at the terminal.
  const renamed = version !== undefined && atLeast(version, ROSTER_RENAME);
  return {
    version,
    rosterKey: renamed ? "entries" : "list",
    ownershipMarker: renamed,
    modelPolicy: renamed,
    rejectsRetiredKeys: renamed,
    sessionsInSqlite: renamed,
    externalChannelPlugins: renamed,
  };
}

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : undefined;
}

/**
 * Reshape a config in place for the installed gateway. Returns one line per
 * change so the caller can log what it did — a config edited silently on every
 * boot is how a surprising setting becomes unattributable.
 *
 * Idempotent: running it twice against the same capabilities changes nothing
 * the second time.
 */
export function applyCompat(config: Dict, caps: Capabilities): string[] {
  const changes: string[] = [];
  const agents = asDict(config.agents);

  if (agents) {
    changes.push(...reshapeRoster(agents, caps));
    changes.push(...reshapeModelPolicy(agents, caps));
  }
  changes.push(...reshapeMemorySearch(config, caps));
  // Runs regardless of roster shape: a per-agent value can outlive the roster
  // conversion that moved it.
  changes.push(...hoistVisibleReplies(config, caps));

  if (caps.rejectsRetiredKeys) {
    for (const [section, key] of RETIRED_KEYS) {
      const node = asDict(config[section]);
      if (node && key in node) {
        delete node[key];
        changes.push(`removed retired ${section}.${key}`);
      }
    }
  }
  return changes;
}

/** `agents.list` (array of {id, ...}) ⇄ `agents.entries` (keyed by id). */
function reshapeRoster(agents: Dict, caps: Capabilities): string[] {
  const changes: string[] = [];

  if (caps.rosterKey === "entries" && Array.isArray(agents.list)) {
    const entries: Dict = { ...(asDict(agents.entries) ?? {}) };
    for (const raw of agents.list) {
      const entry = asDict(raw);
      const id = entry?.id;
      if (typeof id !== "string" || id === "") continue; // unusable without an id
      const { id: _drop, ...rest } = entry as Dict & { id: string };
      entries[id] = rest;
    }
    delete agents.list;
    agents.entries = entries;
    changes.push(`agents.list → agents.entries (${Object.keys(entries).join(", ")})`);
  } else if (caps.rosterKey === "list" && asDict(agents.entries)) {
    const entries = asDict(agents.entries) as Dict;
    agents.list = Object.entries(entries).map(([id, rest]) => ({
      id,
      ...(asDict(rest) ?? {}),
    }));
    delete agents.entries;
    changes.push(`agents.entries → agents.list (${Object.keys(entries).join(", ")})`);
  }

  // The marker is only meaningful for a fleet; a sole agent is told to omit it.
  const roster = caps.rosterKey === "entries" ? asDict(agents.entries) : agents.list;
  const size = Array.isArray(roster) ? roster.length : Object.keys(roster ?? {}).length;
  if (caps.ownershipMarker && size > 1 && agents.ownership !== "explicit") {
    agents.ownership = "explicit";
    changes.push('agents.ownership = "explicit"');
  } else if (!caps.ownershipMarker && "ownership" in agents) {
    delete agents.ownership;
    changes.push("removed agents.ownership (unknown to this gateway)");
  }
  return changes;
}

/** `agents.defaults.models` (restriction) ⇄ `agents.defaults.modelPolicy.allow`. */
function reshapeModelPolicy(agents: Dict, caps: Capabilities): string[] {
  const defaults = asDict(agents.defaults);
  if (!defaults) return [];

  if (caps.modelPolicy) {
    const models = asDict(defaults.models);
    if (models && !defaults.modelPolicy) {
      defaults.modelPolicy = { allow: Object.keys(models).sort() };
      delete defaults.models;
      return ["agents.defaults.models → modelPolicy.allow"];
    }
    return [];
  }

  const policy = asDict(defaults.modelPolicy);
  const allow = policy?.allow;
  if (Array.isArray(allow)) {
    defaults.models = Object.fromEntries(
      allow.filter((m): m is string => typeof m === "string").map((m) => [m, {}]),
    );
    delete defaults.modelPolicy;
    return ["agents.defaults.modelPolicy.allow → models"];
  }
  return [];
}

/**
 * `agents.defaults.memorySearch` ⇄ top-level `memory.search`, and the per-agent
 * `memorySearch` ⇄ that agent's `memory.search`. The inner object is unchanged;
 * only where it hangs moved in 2026.8.1, and each version rejects the other's
 * location outright.
 */
function reshapeMemorySearch(config: Dict, caps: Capabilities): string[] {
  const changes: string[] = [];
  const agents = asDict(config.agents);

  // Global: agents.defaults.memorySearch ⇄ memory.search
  const defaults = asDict(agents?.defaults);
  if (caps.rosterKey === "entries") {
    const legacy = defaults && asDict(defaults.memorySearch);
    if (defaults && legacy) {
      const memory = (config.memory = asDict(config.memory) ?? {});
      memory.search = { ...(asDict(memory.search) ?? {}), ...legacy };
      delete defaults.memorySearch;
      changes.push("agents.defaults.memorySearch → memory.search");
    }
  } else {
    const memory = asDict(config.memory);
    const search = memory && asDict(memory.search);
    if (memory && search && defaults) {
      defaults.memorySearch = { ...(asDict(defaults.memorySearch) ?? {}), ...search };
      delete memory.search;
      if (Object.keys(memory).length === 0) delete config.memory;
      changes.push("memory.search → agents.defaults.memorySearch");
    }
  }

  // Per agent: <agent>.memorySearch ⇄ <agent>.memory.search
  const roster = asDict(agents?.entries) ?? {};
  const listed = Array.isArray(agents?.list) ? (agents.list as unknown[]) : [];
  const holders = [...Object.values(roster), ...listed]
    .map(asDict)
    .filter((v): v is Dict => v !== undefined);

  for (const entry of holders) {
    if (caps.rosterKey === "entries") {
      const legacy = asDict(entry.memorySearch);
      if (!legacy) continue;
      const memory = (entry.memory = asDict(entry.memory) ?? {});
      memory.search = { ...(asDict(memory.search) ?? {}), ...legacy };
      delete entry.memorySearch;
      changes.push("per-agent memorySearch → memory.search");
    } else {
      const memory = asDict(entry.memory);
      const search = memory && asDict(memory.search);
      if (!memory || !search) continue;
      entry.memorySearch = { ...(asDict(entry.memorySearch) ?? {}), ...search };
      delete memory.search;
      if (Object.keys(memory).length === 0) delete entry.memory;
      changes.push("per-agent memory.search → memorySearch");
    }
  }
  return changes;
}

/**
 * Move `groupChat.visibleReplies` off individual agents and onto the global
 * `messages.groupChat`. 2026.8.1+ rejects the per-agent form; both versions
 * accept the global one, so this is a one-way fix rather than a conversion.
 *
 * It genuinely widens the setting — there is no per-agent override upstream —
 * so the change line says so.
 */
function hoistVisibleReplies(config: Dict, caps: Capabilities): string[] {
  const agents = asDict(config.agents);
  if (!agents) return [];
  const roster = asDict(agents.entries) ?? {};
  const listed = Array.isArray(agents.list) ? agents.list : [];
  const holders: Dict[] = [
    ...Object.values(roster).map(asDict),
    ...listed.map(asDict),
  ].filter((v): v is Dict => v !== undefined);

  const changes: string[] = [];
  let hoisted: string | undefined;
  for (const entry of holders) {
    const groupChat = asDict(entry.groupChat);
    const value = groupChat?.visibleReplies;
    if (typeof value !== "string" || !groupChat) continue;
    hoisted = value;
    delete groupChat.visibleReplies;
    if (Object.keys(groupChat).length === 0) delete entry.groupChat;
  }
  if (hoisted === undefined) return changes;

  const messages = (config.messages = asDict(config.messages) ?? {});
  const groupChat = (messages.groupChat = asDict(messages.groupChat) ?? {});
  if (groupChat.visibleReplies !== hoisted) {
    groupChat.visibleReplies = hoisted;
    changes.push(
      `messages.groupChat.visibleReplies = "${hoisted}" — hoisted from per-agent, ` +
        `now applies to every agent` + (caps.rosterKey === "entries" ? "" : " (also valid here)"),
    );
  } else {
    changes.push("dropped per-agent groupChat.visibleReplies (already set globally)");
  }
  return changes;
}
