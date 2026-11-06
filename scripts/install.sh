#!/usr/bin/env bash
# Sets up and starts Shiftbook on a fresh Ubuntu droplet. Run from the Shiftbook folder:
#   sudo bash scripts/install.sh
# Safe to run again: it keeps an existing .env and only rebuilds and restarts.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  echo
  read -rp "Address staff will open (for example https://shiftbook.yourdomain.com): " ORIGIN
  ORIGIN=${ORIGIN%/}
  case "$ORIGIN" in https://*) ;; *) echo "It must start with https://"; exit 1;; esac
  echo
  echo "How does Cloudflare reach this server?"
  echo "  1) Cloudflare Tunnel (recommended: no open web ports)"
  echo "  2) My own reverse proxy (Nginx, Caddy or Traefik) on this droplet"
  read -rp "Choose 1 or 2: " MODE
  TOKEN=""; PORT=8080
  if [ "$MODE" = "1" ]; then
    read -rp "Paste the tunnel token (Zero Trust > Networks > Tunnels): " TOKEN
  else
    # pick the first free local port from 8080 up, so it doesn't clash with your other apps
    while ss -ltn | grep -q ":$PORT "; do PORT=$((PORT + 1)); done
    read -rp "Local port for your reverse proxy to use [$PORT]: " P; PORT=${P:-$PORT}
  fi
  umask 077
  cat > .env <<ENV
APP_ORIGIN=$ORIGIN
DB_OWNER_PASSWORD=$(openssl rand -hex 24)
API_DB_PASSWORD=$(openssl rand -hex 24)
APP_PORT=$PORT
CLOUDFLARE_TUNNEL_TOKEN=$TOKEN
ENV
  echo "Saved .env with new database passwords. Keep a copy somewhere safe."
fi

set -a; . ./.env; set +a
PROFILE=()
[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] && PROFILE=(--profile tunnel)

echo "Building and starting (the first build takes a few minutes)…"
docker compose "${PROFILE[@]}" up -d --build

echo -n "Waiting for Shiftbook to start"
for i in $(seq 1 60); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    echo; echo "Shiftbook is running."
    [ ${#PROFILE[@]} -eq 0 ] && echo "Point your reverse proxy at http://127.0.0.1:${APP_PORT:-8080} for ${APP_ORIGIN#https://}."
    [ ${#PROFILE[@]} -gt 0 ] && echo "In the tunnel's Public hostname, set ${APP_ORIGIN#https://} → HTTP → app:8080."
    echo "Next: sudo bash scripts/create-manager.sh"
    exit 0
  fi
  echo -n "."; sleep 3
done
echo; echo "It didn't start. See: docker compose logs app"; exit 1
