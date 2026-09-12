#!/usr/bin/env bash
# Snapshot OpenClaw's live state and workspaces onto the NAS share.
# Run ON the server (or `ssh <host> openclaw-host/bin/backup-to-nas.sh`).
#
# SCOPE, HONESTLY: the NAS share lives on the same physical disk as the state it
# copies. This protects against logical damage — a bad migration, an `rm -rf`, a
# corrupted SQLite file — which is exactly the 2.0 upgrade risk. It does NOT
# protect against losing the disk. For that, copy a snapshot off the machine.
set -euo pipefail

# Point these at your own layout. WORKSPACES is space-separated; leave it empty
# to snapshot state only.
SRC_STATE=${SRC_STATE:-$HOME/openclaw-state}
DEST=${DEST:-$HOME/nas/openclaw-backup}
WORKSPACES=${WORKSPACES:-$HOME/openclaw-workspace}
KEEP=${KEEP:-5}

stamp=$(date +%Y-%m-%dT%H-%M-%S)
prev=$(ls -1d "$DEST"/2*/ 2>/dev/null | tail -1 || true)
mkdir -p "$DEST/$stamp"

# --link-dest hard-links files unchanged since the previous snapshot, so five
# snapshots of a 6 GB state cost ~6 GB, not 30. Each one is still a full tree:
# restore is a plain copy, no chain to replay.
link=()
[ -n "$prev" ] && link=(--link-dest="${prev%/}")

# Excluded: language runtimes and package caches OpenClaw installed under the
# state dir. They are re-fetchable and dwarf the state that is not.
rsync -a --delete "${link[@]}" \
  --exclude=go --exclude=google-cloud-sdk --exclude=npm --exclude=node24 \
  --exclude=python --exclude=uv-cache --exclude=cache --exclude=tools \
  --exclude=google-analytics --exclude=media \
  "$SRC_STATE/" "$DEST/$stamp/state/"

for ws in $WORKSPACES; do
  [ -d "$ws" ] || continue
  rsync -a --delete "${link[@]}" \
    --exclude=node_modules --exclude=.pnpm-store --exclude=.tmp \
    "$ws/" "$DEST/$stamp/$(basename "$ws")/"
done

# A snapshot nobody can date is a snapshot nobody trusts. This file is what the
# freshness check reads, and it is written LAST so a half-finished run has none.
{
  echo "created: $(date -Is)"
  echo "openclaw: $(docker exec openclaw-host openclaw --version 2>/dev/null | head -1 || echo unknown)"
  echo "agents: $(ls "$DEST/$stamp/state/agents" 2>/dev/null | tr '\n' ' ')"
} > "$DEST/$stamp/MANIFEST"

ls -1d "$DEST"/2*/ 2>/dev/null | head -n -"$KEEP" | xargs -r rm -rf

echo "snapshot: $DEST/$stamp"
du -sh "$DEST/$stamp" "$DEST"
