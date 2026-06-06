#!/bin/bash
# Sidecar MCP server: risk-radar-mcp (https://github.com/cha2hyun/risk-radar-mcp)
#
# Python/FastMCP, HTTP (streamable-http) transport on :8765. Runs as its OWN host
# container — the OpenClaw image stays Node-only. The agent reaches it by container
# name over the shared `oc-net` network (created by run.sh too).
#
# One-time registration with the agent (idempotent; persists in /state/openclaw.json):
#   docker exec openclaw-host openclaw mcp add risk-radar \
#     --transport streamable-http --url http://risk-radar-mcp:8765/mcp
#   docker exec openclaw-host openclaw mcp reload
set -e
REPO=/home/wooogy/risk-radar-mcp
if [ -d "$REPO/.git" ]; then git -C "$REPO" pull --ff-only; else git clone --depth 1 https://github.com/cha2hyun/risk-radar-mcp "$REPO"; fi
docker build -t risk-radar-mcp "$REPO"
docker network create oc-net 2>/dev/null || true
docker rm -f risk-radar-mcp 2>/dev/null || true
docker run -d --name risk-radar-mcp --restart unless-stopped --network oc-net \
  -e RISK_RADAR_HOST=0.0.0.0 -e RISK_RADAR_PORT=8765 \
  risk-radar-mcp
echo "started risk-radar-mcp on oc-net (http://risk-radar-mcp:8765/mcp)."
echo "register once: docker exec openclaw-host openclaw mcp add risk-radar --transport streamable-http --url http://risk-radar-mcp:8765/mcp && docker exec openclaw-host openclaw mcp reload"
