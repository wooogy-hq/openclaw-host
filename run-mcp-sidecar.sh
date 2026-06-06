#!/bin/bash
# run-mcp-sidecar.sh — build & run a SELF-HOSTED MCP server as a sidecar container
# on the shared `oc-net` network, so the openclaw-host agent can reach it by name.
#
# This is ONLY for MCP servers you self-host (the repo ships a Dockerfile). For a
# REMOTE/hosted MCP, skip this entirely and just point the agent at the URL:
#   docker exec openclaw-host openclaw mcp add <name> --transport streamable-http --url <https-url>
#
# Usage:
#   run-mcp-sidecar.sh <container-name> <owner/repo|git-url> [-- <extra docker run args>]
#
# After it starts, register the running server with the agent (one-time; persists
# in openclaw.json):
#   docker exec openclaw-host openclaw mcp add <name> \
#     --transport streamable-http --url http://<container-name>:<port>/mcp
#   docker exec openclaw-host openclaw mcp reload
#
# See examples/mcp-sidecars/ for a concrete example.
# Source is cloned under ${MCP_SRC_DIR:-$HOME/mcp-sidecars}/<container-name>.
# The shared network name is ${OC_NET:-oc-net} (created by run.sh / docker-compose).
set -e

NAME="${1:?usage: run-mcp-sidecar.sh <container-name> <owner/repo|git-url> [-- <docker run args>]}"
REPO="${2:?usage: run-mcp-sidecar.sh <container-name> <owner/repo|git-url> [-- <docker run args>]}"
shift 2
[ "${1:-}" = "--" ] && shift # tolerate an explicit separator

case "$REPO" in
  http://*|https://*|git@*|ssh://*) URL="$REPO" ;;
  */*)                              URL="https://github.com/$REPO" ;;
  *) echo "run-mcp-sidecar: repo must be <owner/repo> or a git URL" >&2; exit 2 ;;
esac

SRC="${MCP_SRC_DIR:-$HOME/mcp-sidecars}/$NAME"
NET="${OC_NET:-oc-net}"

if [ -d "$SRC/.git" ]; then git -C "$SRC" pull --ff-only; else git clone --depth 1 "$URL" "$SRC"; fi
docker build -t "$NAME" "$SRC"
docker network create "$NET" 2>/dev/null || true
docker rm -f "$NAME" 2>/dev/null || true
docker run -d --name "$NAME" --restart unless-stopped --network "$NET" "$@" "$NAME"

echo "started sidecar '$NAME' on network '$NET'."
echo "register with the agent (set <name>/<port> to match the server):"
echo "  docker exec openclaw-host openclaw mcp add <name> --transport streamable-http --url http://$NAME:<port>/mcp"
echo "  docker exec openclaw-host openclaw mcp reload"
