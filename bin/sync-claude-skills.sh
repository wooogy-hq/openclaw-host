#!/usr/bin/env bash
# Push Claude Code skills from this Mac into OpenClaw's shared skill directory,
# so both agents (main / work) get them. Run from the Mac, not the server.
#
# Only SKILL.md skills travel. Claude Code *plugins* do not: hooks, slash
# commands, MCP servers and subagent definitions are Claude Code mechanics, and
# the agents here run Codex. A plugin's skills are still portable — copy them
# out of ~/.claude/plugins/cache/<mp>/<plugin>/<ver>/skills/ into $EXTRA below.
set -euo pipefail

HOST=${OPENCLAW_HOST:-openclaw-home}   # ssh target running the gateway
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# 1. personal skills
for d in "$HOME"/.claude/skills/*; do
  [ -f "$d/SKILL.md" ] || continue
  case "$(basename "$d")" in
    # Pointer skills: they only say "install this Claude plugin", which is not a
    # thing on OpenClaw. The plugin's own skills go in EXTRA instead.
    agent-skills|humanize-korean) continue ;;
  esac
  # -L, not -R: plugin skills symlink their references/ dir, and `docker cp`
  # refuses a symlink that escapes the copied tree.
  cp -RL "$d" "$STAGE"/
done

# 2. Hand-picked plugin skills. This list is a personal selection — edit it.
#    Version dirs are globbed so an upgrade does not silently drop a skill.
EXTRA=(
  "$HOME"/.claude/plugins/cache/ponytail/ponytail/*/skills/*
  "$HOME"/.claude/plugins/cache/im-not-ai/humanize-korean/*/codex/skills/humanize-korean
)
for s in brainstorming systematic-debugging writing-plans executing-plans \
         test-driven-development verification-before-completion writing-skills; do
  EXTRA+=("$HOME"/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/"$s")
done
for d in "${EXTRA[@]}"; do [ -d "$d" ] && cp -RL "$d" "$STAGE"/; done

echo "staged $(find "$STAGE" -name SKILL.md | wc -l | tr -d ' ') skills"
rsync -azL --delete "$STAGE"/ "$HOST":/tmp/claude-skills-import/

# `docker cp src dst` nests src *inside* dst when dst exists, so remove it first
# or the second sync silently lands one level too deep.
ssh "$HOST" '
  docker exec openclaw-host rm -rf /tmp/skills-import
  docker cp /tmp/claude-skills-import openclaw-host:/tmp/skills-import
  docker exec openclaw-host sh -lc "
    for d in /tmp/skills-import/*/; do
      openclaw skills install --global --force \"\$d\" >/dev/null || echo \"FAIL \$d\"
    done
  "
  docker exec openclaw-host sh -lc "
    # --force overwrites SKILL.md, so the gates must be re-applied every push.
    # The container is node-only; without these the agent picks a skill that
    # lists as ready and then discovers the missing binary mid-task.
    gate() {
      f=/state/skills/\$1/SKILL.md; [ -f \"\$f\" ] || return
      grep -q \"^metadata:\" \"\$f\" && return
      awk -v bins=\"\$2\" '"'"'/^---$/ { n++; if (n==2) { print \"metadata:\"; print \"  openclaw:\"; print \"    requires:\"; print \"      bins: [\" bins \"]\" } } { print }'"'"' \"\$f\" > \"\$f.tmp\" && mv \"\$f.tmp\" \"\$f\"
    }
    gate graphify           '"'"'\"graphify\"'"'"'
    gate golangci           '"'"'\"golangci-lint\"'"'"'
    gate go-arch            '"'"'\"go\", \"golangci-lint\"'"'"'
    gate markdown-to-html   '"'"'\"pandoc\"'"'"'
    gate paper-explainer-ko '"'"'\"python3\"'"'"'
    openclaw skills list --agent main | grep \"^Skills\"
  "
  docker exec openclaw-host rm -rf /tmp/skills-import
  rm -rf /tmp/claude-skills-import
'
