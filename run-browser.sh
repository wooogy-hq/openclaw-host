#!/bin/bash
# Containerized browser sidecar — headless Chromium + Playwright driven over HTTP.
# The imperative twin of the `containerized-browser` service in
# docker-compose.sidecars.yml (this host has no compose binary; run.sh is the
# pattern here). Keep the two in sync.
#
# The agent reaches it as http://containerized-browser:8080 on oc-net and drives
# it with POST /exec; a human watches the live view at / via
#   ssh -L 8080:localhost:8080 <host>
set -e
cd "$(dirname "$0")"

# BROWSER_PASSWORD gates everything except /guide.
set -a; . ./.env; set +a
: "${BROWSER_PASSWORD:?set BROWSER_PASSWORD in .env}"

docker network create oc-net 2>/dev/null || true
# Named volume, not a bind mount: the profile is opaque root-owned state.
docker volume create browser-profile >/dev/null

docker stop -t 20 containerized-browser 2>/dev/null || true
docker rm containerized-browser 2>/dev/null || true

docker run -d --name containerized-browser --restart unless-stopped \
  --network oc-net \
  --memory 1500m \
  -p 127.0.0.1:8080:8080 \
  -e AUTH_PASSWORD="$BROWSER_PASSWORD" \
  -e VIEW_WIDTH=1280 -e VIEW_HEIGHT=800 \
  -v browser-profile:/tmp/cdp-profile \
  unknownpgr/containerized-browser:latest
# Loopback only. /exec is arbitrary code execution and this host has a public IP;
# publishing on 0.0.0.0 puts a remote-code endpoint on the internet behind one
# shared password. Reach the viewer through an SSH tunnel instead.
#
# The volume is what makes a logged-in session outlive a restart: the image points
# --user-data-dir at /tmp/cdp-profile, which is otherwise container-local. Without
# it, "a human logs in once and the agent reuses the session" quietly stops working
# the next time the container cycles.
echo "started. viewer: ssh -L 8080:localhost:8080 <host> then http://localhost:8080"
