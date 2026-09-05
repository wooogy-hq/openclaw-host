# Provider-agnostic brain + Codex (ChatGPT subscription) support — Design

Date: 2026-07-27
Status: Approved (design), pending implementation
Repo: `openclaw-host`

## Goal

Let the openclaw agent's conversational brain be **any** LLM backend, switchable by
env with no code change, and specifically add **OpenAI GPT via Codex ChatGPT-subscription
OAuth** as a first-class option — while keeping the current DeepSeek path as a fallback.

Two hard requirements from the user:
1. **Provider- and model-agnostic** — pick provider + model via env; new backends need no code edit.
2. **Both auth modes** — API key *and* OAuth (ChatGPT-subscription) must be supported.

## Key finding that shaped this design

OpenClaw (2026.5.28) has **native** OpenAI/Codex support — the `@openclaw/openai`
plugin is already `enabled`, and `openai/*` agent turns run through openclaw's built-in
**Codex app-server runtime**, authenticated by a **`codex login` ChatGPT-subscription
OAuth** session (`docs/providers/openai.md`). openclaw's own docs state OpenAI supports
subscription-OAuth use in external tools like openclaw. → **No third-party proxy
(ChatMock) and no sidecar are needed.** This supersedes the earlier proxy design.

Custom OpenAI-compatible backends are also natively configurable via
`models.providers.<name>.baseUrl` + `api: "openai-completions"` (used by litellm/sglang/…),
which we reuse for the generic "custom" provider below.

## Architecture — two changes, no new services

### 1. Host provider abstraction (`src/provider-config.ts`)

Generalize the hardcoded `"anthropic" | "bedrock" | "deepseek"` union into a registry
plus a generic escape hatch. `ProviderConfig` gains two fields:

- `authMode: "api-key" | "oauth"` — from `AI_AUTH` (default per provider).
- `baseUrl?: string` — from `AI_BASE_URL` (custom openai-compatible endpoints).

Named providers keep convenient defaults:

| `AI_PROVIDER` | openclawProvider | openclawApi         | default authMode | default model |
|---------------|------------------|---------------------|------------------|---------------|
| anthropic     | anthropic        | anthropic           | api-key          | claude-sonnet-4-20250514 |
| deepseek      | deepseek         | openai-compat       | api-key          | deepseek-v4-pro |
| bedrock       | amazon-bedrock   | bedrock-converse-…  | aws-sdk          | (region CRIS) |
| **openai**    | openai           | (native codex rt)   | **oauth**        | gpt-5.5 |

**Generic/agnostic path** — `AI_PROVIDER` set to any other name is no longer rejected;
it is treated as a custom provider fully described by env:
`AI_PROVIDER=<name>`, `AI_BASE_URL=<url>`, `AI_OPENCLAW_API=<openai-completions|anthropic-messages>`,
`AI_AUTH=<key|oauth>`, `AI_MODEL=<model>`. This is what makes it truly agnostic —
future backends (litellm, an OpenAI-compatible gateway, etc.) need only env.

`AI_MODEL` continues to override the default model for every provider (model-agnostic).

### 2. openclaw config emission (`src/config.ts` → `buildOpenclawConfig`)

Today it writes only `agents.defaults.model.primary = "<openclawProvider>/<model>"`.
Extend it to also emit, when applicable:

- `agents.defaults.model.primary = "<openclawProvider>/<model>"` (unchanged shape).
- When `baseUrl` is set (custom/openai-compat): a `models.providers.<openclawProvider>`
  block `{ baseUrl, api: <openclawApi>, apiKey: "${AI_API_KEY}" (key mode only) }`.
- When `provider=openai` + `authMode=oauth`: rely on the native Codex runtime +
  the `codex login` session; set `auth.order.openai` to prefer the subscription profile.
  (Exact key confirmed in the pre-impl spike below.)

Secrets are still **never** written to openclaw.json — API keys stay in env; the Codex
OAuth session stays in `/state/.codex/auth.json`. This preserves the repo's invariant.

### Auth bootstrap (operational, not code)

- **oauth (Codex/ChatGPT subscription):** `codex login` produces `/state/.codex/auth.json`
  (HOME=/state). Headless options: pipe an access token (`… | codex login --with-access-token`)
  or copy an `auth.json` obtained by an interactive login elsewhere. Tokens auto-refresh
  (proactive ~8d / on 401). Persisted in the `/state` bind mount → survives restart/redeploy.
- **api-key:** provider API key via `.env` (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`),
  read by openclaw at runtime.

## Data flow

```
.env (AI_PROVIDER / AI_MODEL / AI_AUTH / AI_BASE_URL / *_API_KEY)
   -> loadConfig -> resolveProviderConfig  (provider-config.ts)
   -> buildOpenclawConfig                  (config.ts: model.primary [+ models.providers] [+ auth.order])
   -> merge over existing openclaw.json    (preserves mcp/meta)
   -> openclaw gateway boots
        openai+oauth: Codex runtime reads /state/.codex/auth.json  (ChatGPT subscription)
        key modes:    plugin reads *_API_KEY from env
```

## Pre-implementation spike (do first)

Confirm the exact openclaw config keys for selecting the Codex-OAuth auth profile for
`openai/*` (`auth.order.openai` vs an `openai-codex` auth profile, and whether openclaw
reads codex CLI's `/state/.codex/auth.json` directly or needs `openclaw onboard`). Read
`docs/providers/openai.md` + `docs/plugins/codex*.md` and validate on the container.
If subscription-OAuth needs an openclaw-side onboarding step, capture that command.

## Testing

Unit (vitest, extend existing suites):
- `provider-config.test.ts`: `openai` resolves (openclawProvider `openai`, default model `gpt-5.5`, default authMode `oauth`); `AI_AUTH=key` flips authMode; `AI_MODEL` override; custom provider via `AI_BASE_URL`/`AI_OPENCLAW_API`; the "unsupported provider" test moves to asserting the generic path (or a validation error only for empty/invalid shapes).
- `config.test.ts`: `buildOpenclawConfig` emits `openai/gpt-5.5` primary; emits `models.providers.<name>` with baseUrl for custom; **never** leaks secrets into openclaw.json (extend the existing no-secret assertion for `*_API_KEY`).

Integration (manual, on container, gated by the human OAuth step):
- `codex login` → `openai/gpt-5.5` set → agent replies via Telegram using the subscription.
- Fallback: `AI_PROVIDER=deepseek` restores current behavior.

## Rollout & fallback

- Deploy via `run.sh` (image rebuild; `/state` + workspace persist). `.env` flip + reboot.
- Instant rollback: set `AI_PROVIDER=deepseek` and reboot — the agnostic design makes the
  brain a single env switch.

## Risks

1. **ToS** — materially lower than the proxy approach (native, openclaw-documented as
   OpenAI-supported), but still the user's accepted risk; the ChatGPT account is what's
   exposed if OpenAI disallows the pattern.
2. **Headless refresh failure** — if the refresh token is invalidated (password change,
   forced logout), no browser exists to re-login; needs a re-copy of `auth.json`. Add a
   note to `guides/`/ops so a silent auth failure is diagnosable.
3. **Spike outcome** — if openclaw needs an onboarding step for the codex auth profile,
   that becomes an extra boot/setup step (captured by the spike before coding).

## Out of scope

App-run/deploy of other services, the HTML-viewer idea (separate spec), and any
ChatMock/proxy path (explicitly dropped).
