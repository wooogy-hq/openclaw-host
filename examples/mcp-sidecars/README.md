# Example: self-hosted MCP sidecars

`openclaw-host` can use MCP servers. There are two cases:

- **Remote / hosted MCP** — nothing to deploy. Just point the agent at the URL:
  ```bash
  docker exec openclaw-host openclaw mcp add <name> --transport streamable-http --url https://example.com/mcp
  docker exec openclaw-host openclaw mcp reload
  ```
- **Self-hosted MCP** — the server ships a Dockerfile and you run it yourself. The
  agent container is intentionally Node-only (no Python/uv, no docker socket), so a
  self-hosted MCP runs as its **own sidecar container** on the shared `oc-net`
  network and the agent connects to it by container name. Use
  [`run-mcp-sidecar.sh`](../../run-mcp-sidecar.sh) (generic) for this.

The example below is **illustrative** — `risk-radar-mcp` is one specific server, not
part of the core. Swap in any self-hosted MCP repo.

---

## Example: [risk-radar-mcp](https://github.com/cha2hyun/risk-radar-mcp)

Python/FastMCP, streamable-http on `:8765`, exposes market/quote tools. No required
API keys.

```bash
# 1) build + run the sidecar on oc-net (binds 0.0.0.0 so the agent can reach it)
./run-mcp-sidecar.sh risk-radar-mcp cha2hyun/risk-radar-mcp -- \
  -e RISK_RADAR_HOST=0.0.0.0 -e RISK_RADAR_PORT=8765

# 2) register it with the agent (one-time; persists in openclaw.json)
docker exec openclaw-host openclaw mcp add risk-radar \
  --transport streamable-http --url http://risk-radar-mcp:8765/mcp
docker exec openclaw-host openclaw mcp reload

# 3) verify
docker exec openclaw-host openclaw mcp probe risk-radar   # -> 7 tools
```

Notes:
- The sidecar **must** bind `0.0.0.0` (not `127.0.0.1`) or the agent container can't reach it.
- A reachable `/mcp` endpoint answers `HTTP 406` to a bare `GET` — that means alive, not broken.
- `run.sh` keeps `openclaw-host` attached to `oc-net` across redeploys; the registration
  survives restarts via the openclaw.json merge (see [`docs/troubleshooting.md`](../../docs/troubleshooting.md)).
