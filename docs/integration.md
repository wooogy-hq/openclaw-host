# OpenClaw ↔ Claude Code integration (home server)

How the home-server agent stack fits together: OpenClaw is the chat/orchestration
front-end; coding is delegated to a backend-agnostic `code-agent` (Claude Code by
default, Codex optional); state lives in S3; git is scoped to the `wooogy-hq` org.

```mermaid
flowchart TD
    User([User]) -->|Telegram DM| TG["Telegram (@wooogybot)"]
    TG --> OC["OpenClaw gateway<br/>deepseek-v4-pro<br/>(container, uid 1000)"]

    OC -->|reads on startup| AG["AGENTS.md<br/>“delegate coding to code-agent”"]
    OC -->|coding task| CA["code-agent (wrapper)<br/>CODING_AGENT switch"]

    CA -->|claude default| CC["Claude Code<br/>claude -p"]
    CA -.->|CODING_AGENT=codex| CX["Codex<br/>codex exec"]

    CC -->|auto-loads| SK["~/.claude/skills<br/>go-arch · go-arch-flat · golangci-lint"]
    CC -->|reads/writes files| WS["/data/workspace<br/>(host /home/wooogy/openclaw-workspace)"]
    CX -.-> WS

    WS <-->|restore on start / periodic + shutdown backup| S3[("S3 bucket<br/>workspaces/ + sessions/<br/>shared with serverless-openclaw")]

    CC -.->|auth| CT["CLAUDE_CODE_OAUTH_TOKEN<br/>(Claude subscription)"]
    CC -->|git clone/commit/push| GH["github.com/wooogy-hq/*"]
    GH -.->|auth via git credential helper| GT["GITHUB_TOKEN<br/>fine-grained PAT<br/>(wooogy-hq org only)"]

    subgraph HomeServer["Home-server mini PC (Ubuntu, Docker, restart=unless-stopped)"]
        OC
        CA
        CC
        CX
        SK
        WS
    end
```

## Key points
- **Two skill systems:** OpenClaw (deepseek) has its own skills; the go-arch /
  golangci-lint skills live in Claude Code's `~/.claude/skills` and apply when
  OpenClaw delegates coding to `code-agent` → `claude`.
- **Backend-agnostic coding:** `CODING_AGENT=claude|codex` swaps the coding CLI
  with no other change.
- **S3 = source of truth:** the workspace and sessions sync to the same bucket as
  the serverless deployment (one active environment at a time per user).
- **Scoped git:** the container's git uses a fine-grained PAT limited to the
  `wooogy-hq` org — it can clone/push wooogy-hq repos and nothing else.
