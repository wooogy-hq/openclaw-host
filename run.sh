#!/bin/bash
# Reproducible run for openclaw-host (files scope, runs as the host's uid).
#
# Paths and uid come from the environment, with defaults under $HOME. The names
# match docker-compose.yml deliberately: both tools must land on the SAME state,
# or switching between them silently forks your agent's history.
#
#   HOST_WORKSPACE=/srv/oc/ws HOST_STATE=/srv/oc/state bash run.sh
#
# Optional extras are opt-in and skipped when unset:
#   HOST_WORKSPACE_WORK   a second agent's workspace (see "Agents & channels")
#   HOST_KUBECTL          read-only kubectl binary to bind-mount in
set -e
cd "$(dirname "$0")"

[ -f .env ] || { echo "no .env — copy .env.example and fill it in" >&2; exit 1; }
# docker compose reads .env on its own; do the same here so HOST_* set there
# applies to both tools. Without this the two disagree about where state lives,
# which is the one way they must never differ.
set -a; . ./.env; set +a

HOST_WORKSPACE=${HOST_WORKSPACE:-$HOME/openclaw-workspace}
HOST_STATE=${HOST_STATE:-$HOME/openclaw-state}
HOST_SKILLS=${HOST_SKILLS:-$HOME/openclaw-skills}
HOST_UID=${HOST_UID:-$(id -u)}
HOST_GID=${HOST_GID:-$(id -g)}

# Build args come from .env too, so one file decides what the image contains.
docker build -t openclaw-host \
  --build-arg "WITH_GITOPS_TOOLS=${WITH_GITOPS_TOOLS:-0}" \
  ${OPENCLAW_VERSION:+--build-arg "OPENCLAW_VERSION=$OPENCLAW_VERSION"} \
  ${AGENT_SKILLS_REF:+--build-arg "AGENT_SKILLS_REF=$AGENT_SKILLS_REF"} \
  ${CLAUDE_CODE_VERSION:+--build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION"} \
  ${CODEX_VERSION:+--build-arg "CODEX_VERSION=$CODEX_VERSION"} \
  .
mkdir -p "$HOST_WORKSPACE" "$HOST_STATE" "$HOST_SKILLS"

mounts=(
  -v "$HOST_WORKSPACE:/data/workspace"
  -v "$HOST_STATE:/state"
  -v "$HOST_SKILLS:/skills"
)
# A second agent needs its workspace bind-mounted too: /data is root-owned in
# the image, so an unmounted workspace is unwritable and dies with the container.
if [ -n "${HOST_WORKSPACE_WORK:-}" ]; then
  mkdir -p "$HOST_WORKSPACE_WORK"
  mounts+=(-v "$HOST_WORKSPACE_WORK:/data/workspace-work")
fi
# Read-only kubectl, so the agent can `get/describe/logs` to self-verify a
# deploy but not mutate. Its kubeconfig belongs in the state mount at
# /state/.kube/config; scope the token to a view-only ClusterRole.
if [ -n "${HOST_KUBECTL:-}" ]; then
  mounts+=(-v "$HOST_KUBECTL:/usr/local/bin/kubectl:ro")
fi

# Shared network so the agent reaches sidecar MCP servers by container name.
docker network create oc-net 2>/dev/null || true
docker stop -t 150 openclaw-host 2>/dev/null || true
docker rm openclaw-host 2>/dev/null || true

docker run -d --name openclaw-host --restart unless-stopped \
  --user "$HOST_UID:$HOST_GID" \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --env-file .env \
  -e WORKSPACE_DIR=/data/workspace -e OPENCLAW_STATE_DIR=/state \
  -e OPENCLAW_BIN=openclaw -e OPENCLAW_DISABLE_BONJOUR=1 -e HOME=/state \
  "${mounts[@]}" \
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
# untrusted input from a chat channel. Isolation still rests on the unprivileged
# uid plus the bind mounts above.

# Attach to oc-net in addition to the default bridge (so MCP DNS by name works).
docker network connect oc-net openclaw-host 2>/dev/null || true
echo "started. logs: docker logs -f openclaw-host"
