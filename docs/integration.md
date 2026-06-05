# openclaw-host — architecture

A single home-server mini-PC runs two cooperating layers:

1. **Agent layer** — `serverless-openclaw`, dockerized, running OpenClaw (DeepSeek)
   with **Claude Code** as the coding agent, state synced to S3.
2. **Platform layer** — **k3s + Flux GitOps**: the agent pushes ops manifests to
   GitHub, Flux pulls them, and apps deploy to the cluster automatically — exposed
   to the internet over HTTPS.

## System overview

```mermaid
flowchart TB
    TGU(["📱 Telegram user"]):::user
    WEBU(["🌐 Internet user"]):::user

    subgraph HOST["🖥️ Home-server mini-PC · Ubuntu"]
        direction TB

        subgraph DOCKER["🐳 openclaw-host (Docker) — serverless-openclaw, dockerized"]
            direction TB
            OC["🤖 OpenClaw gateway<br/>DeepSeek v4 Pro · native Telegram"]:::agent
            CAG["⚙️ code-agent<br/>CODING_AGENT switch"]:::agent
            CLA["🧠 Claude Code"]:::agent
            COD["Codex · optional"]:::agent
            SKL["📚 skills<br/>go-arch · golangci-lint"]:::agent
            OC --> CAG --> CLA
            CAG -.-> COD
            CLA -.- SKL
        end

        subgraph K3S["☸️ k3s + Flux GitOps"]
            direction TB
            FLX["🔁 Flux"]:::cluster
            CM["🔐 cert-manager"]:::cluster
            TRF["🚦 Traefik ingress<br/>:80 / :443"]:::cluster
            POD["📦 apps namespace<br/>restricted PSS"]:::cluster
            FLX --> POD
            CM -. issues TLS .-> TRF
            TRF --> POD
        end
    end

    subgraph GH["🐙 GitHub · wooogy-hq org"]
        INF[("infra<br/>charts · HelmReleases · Flux")]:::gh
        REP[("app repos<br/>notecall · kb · …")]:::gh
    end

    subgraph EXT["☁️ External"]
        S3[("🪣 S3 bucket<br/>workspace + sessions<br/>shared w/ AWS serverless")]:::ext
        LE["🔏 Let's Encrypt"]:::ext
        DUK["🦆 DuckDNS"]:::ext
    end

    TGU <-->|chat| OC
    OC <-->|restore / backup| S3
    REP -.->|clone / push| CLA
    CLA ==>|git push manifests| INF
    INF ==>|Flux pulls main| FLX
    CM -.-> LE
    DUK -.->|A record| TRF
    WEBU ==>|"https://wooogy-hq.duckdns.org"| TRF

    classDef user fill:#fee2e2,stroke:#ef4444,color:#7f1d1d;
    classDef agent fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a;
    classDef cluster fill:#dcfce7,stroke:#22c55e,color:#14532d;
    classDef gh fill:#f3e8ff,stroke:#a855f7,color:#581c87;
    classDef ext fill:#fef9c3,stroke:#ca8a04,color:#713f12;
```

## Deploy loop (GitOps — the agent never holds cluster creds)

```mermaid
flowchart LR
    A["🤖 OpenClaw<br/>code-agent"]:::a -->|① edit chart + values| M["📝 manifests"]:::m
    M -->|② make validate<br/>helm · kubeconform · conftest| M
    A -->|③ commit + push| R[("wooogy-hq/infra")]:::r
    R -->|④ CI re-validates · gate| CI["✅ GitHub Actions"]:::ci
    R -->|⑤ pull main| F["🔁 Flux"]:::f
    F -->|⑥ apply + health-check| K["☸️ k3s → 🌐 HTTPS"]:::k

    classDef a fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a;
    classDef m fill:#f1f5f9,stroke:#64748b,color:#0f172a;
    classDef r fill:#f3e8ff,stroke:#a855f7,color:#581c87;
    classDef ci fill:#dcfce7,stroke:#22c55e,color:#14532d;
    classDef f fill:#cffafe,stroke:#06b6d4,color:#164e63;
    classDef k fill:#fef9c3,stroke:#ca8a04,color:#713f12;
```

## Key points
- **Two layers, one box.** The dockerized agent (OpenClaw + Claude Code) and the
  k3s GitOps platform run on the same mini-PC; Docker and k3s (containerd) coexist.
- **Coding → Claude Code.** OpenClaw delegates coding to a backend-agnostic
  `code-agent` (Claude Code by default, Codex via `CODING_AGENT=codex`).
- **S3 = single source of truth.** Workspace + sessions sync to the same bucket as
  the AWS serverless-openclaw deployment.
- **Deploy = git commit.** The agent never touches the cluster: it validates and
  commits manifests to `wooogy-hq/infra`; Flux reconciles them. CI + conftest +
  Flux health-checks gate every change.
- **Public HTTPS, no tunnel.** Real public IP with :80/:443 open → Traefik;
  DuckDNS for the hostname (DDNS CronJob tracks the IP); cert-manager + Let's
  Encrypt for TLS.
