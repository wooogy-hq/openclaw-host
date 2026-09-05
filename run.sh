#!/bin/bash
# Reproducible run for openclaw-host (files-scope, runs as host uid 1000).
set -e
cd "$(dirname "$0")"
docker build -t openclaw-host .
mkdir -p /home/wooogy/openclaw-workspace /home/wooogy/openclaw-workspace-work \
  /home/wooogy/openclaw-state /home/wooogy/openclaw-skills
# Shared network so the agent can reach sidecar MCP servers (e.g. risk-radar-mcp)
# by container name. See run-risk-radar-mcp.sh.
docker network create oc-net 2>/dev/null || true
docker stop -t 150 openclaw-host 2>/dev/null || true; docker rm openclaw-host 2>/dev/null || true
docker run -d --name openclaw-host --restart unless-stopped \
  --user 1000:1000 \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --env-file .env \
  -e WORKSPACE_DIR=/data/workspace -e OPENCLAW_STATE_DIR=/state \
  -e OPENCLAW_BIN=openclaw -e OPENCLAW_DISABLE_BONJOUR=1 -e HOME=/state \
  -v /home/wooogy/openclaw-workspace:/data/workspace \
  -v /home/wooogy/openclaw-workspace-work:/data/workspace-work \
  -v /home/wooogy/openclaw-state:/state \
  -v /home/wooogy/openclaw-skills:/skills \
  -v /home/wooogy/openclaw-state/bin/kubectl:/usr/local/bin/kubectl:ro \
  openclaw-host
# Codex sandboxes every shell command with bubblewrap, which needs to create a
# user namespace and remount /. Docker's default seccomp blocks the first and its
# AppArmor profile the second, so every agent shell call died with
#   bwrap: No permissions to create a new namespace
# Both must be unconfined — tested: seccomp alone fails at "make / slave",
# apparmor alone still fails at namespace creation, and cap-add SYS_ADMIN in
# place of either does not help. Codex's own escape hatch (danger-full-access)
# is not reachable: openclaw narrows it back (openclaw/openclaw#83018), and the
# vendored bwrap is a musl build with no setuid support.
# Net effect: the container's syscall/mount confinement is traded for Codex's
# per-command sandbox, which is what actually constrains an agent taking
# untrusted input from Discord. Isolation still rests on uid 1000 + the bind
# mounts below.
# Read-only kubectl: the binary is bind-mounted above; its kubeconfig lives in the
# state mount at /state/.kube/config (= $HOME/.kube/config). The token is the
# cluster SA `kube-system:agent-readonly` (view ClusterRole — read-only, no Secrets).
# So the agent can `kubectl get/describe/logs` to self-verify deploys, not mutate.
# Attach to oc-net in addition to the default bridge (so MCP DNS by name works).
docker network connect oc-net openclaw-host 2>/dev/null || true
echo "started. logs: docker logs -f openclaw-host"
