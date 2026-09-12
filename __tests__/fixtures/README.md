# fixtures

`legacy-openclaw.json` is a 2026.7.x-shaped OpenClaw config. Every key in it is
one that 2026.8.1+ moved, renamed, or rejects outright:

| key | what happens on 2026.8.1+ |
|---|---|
| `agents.list` | rejected — becomes `agents.entries`, keyed by id |
| *(absent)* `agents.ownership` | required once the roster has more than one agent |
| `agents.defaults.models` | superseded by `modelPolicy.allow` |
| `agents.defaults.memorySearch` | moved to top-level `memory.search` |
| per-agent `groupChat.visibleReplies` | rejected — only the global `messages.groupChat` form survives |
| `meta.lastTouchedAt`, `plugins.bundledDiscovery` | rejected, though 2026.7.x wrote them itself |

The `compat` CI job installs `openclaw@latest`, reshapes this file with
`bin/openclaw-compat.mjs`, and runs `openclaw config validate` on the result.
Unit tests can only check the transform against what we believed at the time;
this checks it against the gateway that actually has to boot on it. When
upstream changes the shape again, that job fails here rather than on someone's
machine at startup.

It carries no real ids, tokens or hostnames, and `channels.telegram.enabled` is
`false` so nothing tries to connect.
