#!/usr/bin/env bash
# Snapshot OpenClaw's live state and workspaces onto the NAS share, then (if
# configured) push the snapshot off the machine with restic.
# Run ON the server (or `ssh <host> openclaw-host/bin/backup-to-nas.sh`).
#
# SCOPE, HONESTLY: the NAS share lives on the same physical disk as the state it
# copies. The local snapshot protects against logical damage — a bad migration,
# an `rm -rf`, a corrupted SQLite file. Only the restic copy survives losing the
# disk, so a run without RESTIC_ENV is half a backup and says so.
set -euo pipefail

# Point these at your own layout. WORKSPACES is space-separated; leave it empty
# to snapshot state only.
SRC_STATE=${SRC_STATE:-$HOME/openclaw-state}
DEST=${DEST:-$HOME/nas/openclaw-backup}
WORKSPACES=${WORKSPACES:-$HOME/openclaw-workspace}
KEEP=${KEEP:-5}
# KEY=value file: RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE, AWS_* and optionally
# TELEGRAM_BOT_TOKEN + ALERT_CHAT_ID for failure alerts.
RESTIC_ENV=${RESTIC_ENV:-$HOME/.config/restic/env}
RESTIC=${RESTIC:-$(command -v restic || echo "$HOME/bin/restic")}

if [ -f "$RESTIC_ENV" ]; then set -a; . "$RESTIC_ENV"; set +a; fi

# A cron job that fails silently is how this script went from "daily" to one
# snapshot in seven weeks. Say it somewhere a human reads.
alert() {
  echo "backup-to-nas: $*" >&2
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ] || return 0
  curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$ALERT_CHAT_ID" \
    --data-urlencode "text=⚠️ NAS backup ($(hostname)): $*" || true
}
trap 'alert "failed at line $LINENO (exit $?)"' ERR

# Two runs at once would race on the same "previous snapshot".
exec 9>"$DEST.lock"
flock -n 9 || { echo "backup-to-nas: another run holds $DEST.lock" >&2; exit 0; }

mkdir -p "$DEST"
# Only finished snapshots count: MANIFEST is written last. A run killed halfway
# (power cut, OOM) leaves a dir without one; using it as the hard-link base
# would silently copy everything, and keeping it would crowd out good ones.
for d in "$DEST"/2*/; do
  [ -d "$d" ] && [ ! -f "$d/MANIFEST" ] && rm -rf "$d"
done
prev=$(ls -1d "$DEST"/2*/ 2>/dev/null | tail -1 || true)
prev=${prev%/}

stamp=$(date +%Y-%m-%dT%H-%M-%S)
snap="$DEST/$stamp"
mkdir -p "$snap"

# --link-dest hard-links files unchanged since the previous snapshot, so five
# snapshots of a 6 GB state cost ~6 GB, not 30. It must name the matching
# SUBTREE of the previous snapshot: pointing it at the snapshot root makes rsync
# look for state/foo at prev/foo, find nothing, and copy every byte.
linkto() { [ -n "$prev" ] && [ -d "$prev/$1" ] && echo "--link-dest=$prev/$1"; true; }

# Excluded: language runtimes and package caches OpenClaw installed under the
# state dir. They are re-fetchable and dwarf the state that is not.
# shellcheck disable=SC2046
rsync -a --delete $(linkto state) \
  --exclude=go --exclude=google-cloud-sdk --exclude=npm --exclude=node24 \
  --exclude=python --exclude=uv-cache --exclude=cache --exclude=tools \
  --exclude=google-analytics --exclude=media \
  --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' \
  "$SRC_STATE/" "$snap/state/"

# rsync copies a live SQLite file byte by byte while the gateway writes to it,
# and the WAL holds commits the main file does not have yet. Re-take each one
# through SQLite's online backup API, which yields a consistent single file.
# Written to a temp name and renamed: the rsync copy may be a hard link into the
# previous snapshot, and writing through it would corrupt that one too.
( cd "$SRC_STATE" && find . -name '*.sqlite' \
    -not -path './npm/*' -not -path './node24/*' -not -path './python/*' ) |
while IFS= read -r rel; do
  out="$snap/state/${rel#./}"
  python3 - "$SRC_STATE/${rel#./}" "$out.tmp" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=30)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close(); src.close()
PY
  mv -f "$out.tmp" "$out"
done

for ws in $WORKSPACES; do
  [ -d "$ws" ] || continue
  name=$(basename "$ws")
  # shellcheck disable=SC2046
  rsync -a --delete $(linkto "$name") \
    --exclude=node_modules --exclude=.pnpm-store --exclude=.tmp \
    "$ws/" "$snap/$name/"
done

# A snapshot nobody can date is a snapshot nobody trusts. This file is what the
# freshness check reads, and it is written LAST so a half-finished run has none.
{
  echo "created: $(date -Is)"
  echo "openclaw: $(docker exec openclaw-host openclaw --version 2>/dev/null | head -1 || echo unknown)"
  echo "agents: $(ls "$snap/state/agents" 2>/dev/null | tr '\n' ' ')"
} > "$snap/MANIFEST"

ls -1d "$DEST"/2*/ 2>/dev/null | head -n -"$KEEP" | xargs -r rm -rf

echo "snapshot: $snap"
du -sh "$snap" "$DEST"

# Off the machine. Backs up the snapshot just taken, not the live dirs, so the
# remote copy has the same consistent SQLite files. The `latest` symlink keeps
# restic's paths stable across runs, which is what lets it dedupe.
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  ln -sfn "$snap" "$DEST/latest"
  "$RESTIC" backup --quiet --host "$(hostname)" --tag nas "$DEST/latest/"
  echo "offsite: $("$RESTIC" snapshots --latest 1 --compact | tail -n +3 | head -1)"
else
  echo "offsite: not configured (no RESTIC_REPOSITORY) — this copy dies with the disk" >&2
fi
