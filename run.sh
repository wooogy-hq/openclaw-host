#!/bin/bash
# Reproducible run for openclaw-host (files-scope, runs as host uid 1000).
set -e
cd "$(dirname "$0")"
docker build -t openclaw-host .
mkdir -p /home/wooogy/openclaw-workspace /home/wooogy/openclaw-state /home/wooogy/openclaw-skills
# Shared network so the agent can reach sidecar MCP servers (e.g. risk-radar-mcp)
# by container name. See run-risk-radar-mcp.sh.
docker network create oc-net 2>/dev/null || true
docker stop -t 150 openclaw-host 2>/dev/null || true; docker rm openclaw-host 2>/dev/null || true
docker run -d --name openclaw-host --restart unless-stopped \
  --user 1000:1000 \
  --env-file .env \
  -e WORKSPACE_DIR=/data/workspace -e OPENCLAW_STATE_DIR=/state \
  -e OPENCLAW_BIN=openclaw -e OPENCLAW_DISABLE_BONJOUR=1 -e HOME=/state \
  -v /home/wooogy/openclaw-workspace:/data/workspace \
  -v /home/wooogy/openclaw-state:/state \
  -v /home/wooogy/openclaw-skills:/skills \
  -v /home/wooogy/openclaw-state/bin/kubectl:/usr/local/bin/kubectl:ro \
  openclaw-host
# Read-only kubectl: the binary is bind-mounted above; its kubeconfig lives in the
# state mount at /state/.kube/config (= $HOME/.kube/config). The token is the
# cluster SA `kube-system:agent-readonly` (view ClusterRole — read-only, no Secrets).
# So the agent can `kubectl get/describe/logs` to self-verify deploys, not mutate.
# Attach to oc-net in addition to the default bridge (so MCP DNS by name works).
docker network connect oc-net openclaw-host 2>/dev/null || true
echo "started. logs: docker logs -f openclaw-host"
