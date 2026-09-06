# Point GITHUB_TOKEN at the token belonging to whichever agent is running.
#
# git and gh-api route themselves (see bin/git-credential-oc), but an agent that
# reaches for $GITHUB_TOKEN directly — the reflex, and what most snippets and
# GitHub Actions examples do — gets the default token and a 404 from any other
# org. A 404 reads as "repo missing" or "token stale", so the agent concludes the
# wrong thing and reports that its token was never injected. Documenting gh-api
# did not stop that; this does, by making the reflex correct.
#
# OpenClaw runs every shell tool call as `bash -lc`, which sources this file with
# PWD already set to the agent's working directory — the same signal the
# credential helper routes on. Keep the two tables in step.
case "$PWD/" in
  /data/workspace-work/*)
    [ -r /state/.gh-token-saju ] && GITHUB_TOKEN=$(cat /state/.gh-token-saju)
    ;;
esac
export GITHUB_TOKEN
