#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-auto}"
PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
TOKEN="${WEBHOOK_TOKEN:-}"
CF_TUNNEL_NAME="${CF_TUNNEL_NAME:-}"

if [[ "$MODE" == "--help" || "$MODE" == "-h" ]]; then
  cat <<'HELP'
Usage: scripts/share.sh [auto|ngrok|cloudflared|cloudflared-named]

Environment variables:
  PORT            App port (default: 8080)
  HOST            App host (default: 0.0.0.0)
  WEBHOOK_TOKEN   Required for safe public sharing
  CF_TUNNEL_NAME  Required only for cloudflared-named mode
HELP
  exit 0
fi

if [[ -z "$TOKEN" ]]; then
  echo "Error: WEBHOOK_TOKEN is required for public sharing."
  echo "Example: WEBHOOK_TOKEN=\"$(openssl rand -hex 24)\" npm run share"
  exit 1
fi

pick_tunnel() {
  if [[ "$MODE" == "ngrok" || "$MODE" == "cloudflared" || "$MODE" == "cloudflared-named" ]]; then
    echo "$MODE"
    return
  fi

  if command -v ngrok >/dev/null 2>&1; then
    echo "ngrok"
    return
  fi

  if command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared"
    return
  fi

  echo ""
}

TUNNEL="$(pick_tunnel)"
if [[ -z "$TUNNEL" ]]; then
  echo "Error: install ngrok or cloudflared first."
  echo "ngrok: https://ngrok.com/download"
  echo "cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

cleanup() {
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" >/dev/null 2>&1 || true
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  [[ -n "${LOG_TAIL_PID:-}" ]] && kill "$LOG_TAIL_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Starting app on ${HOST}:${PORT}"
HOST="$HOST" PORT="$PORT" WEBHOOK_TOKEN="$TOKEN" npm start >/tmp/poc-realtime-app.log 2>&1 &
APP_PID=$!

sleep 1
if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
  echo "App failed to start. Check /tmp/poc-realtime-app.log"
  exit 1
fi

if [[ "$TUNNEL" == "ngrok" ]]; then
  echo "Starting ngrok tunnel on port ${PORT}"
  ngrok http "$PORT" &
  TUNNEL_PID=$!
  wait "$TUNNEL_PID"
elif [[ "$TUNNEL" == "cloudflared-named" ]]; then
  if [[ -z "$CF_TUNNEL_NAME" ]]; then
    echo "Error: CF_TUNNEL_NAME is required for cloudflared-named mode."
    echo "Example: CF_TUNNEL_NAME=realtime-chat WEBHOOK_TOKEN=shared-secret npm run share:cloudflared:named"
    exit 1
  fi
  echo "Starting named cloudflared tunnel: ${CF_TUNNEL_NAME}"
  cloudflared tunnel run "$CF_TUNNEL_NAME" --protocol http2 &
  TUNNEL_PID=$!
  wait "$TUNNEL_PID"
else
  echo "Starting cloudflared tunnel to localhost:${PORT}"
  TUNNEL_LOG_FILE="$(mktemp -t poc-cloudflared-log.XXXXXX)"
  cloudflared tunnel --url "http://127.0.0.1:${PORT}" --protocol http2 >"$TUNNEL_LOG_FILE" 2>&1 &
  TUNNEL_PID=$!
  for _ in {1..60}; do
    if ! kill -0 "$TUNNEL_PID" >/dev/null 2>&1; then
      break
    fi
    PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG_FILE" | head -n 1 || true)"
    if [[ -n "$PUBLIC_URL" ]]; then
      echo ""
      echo "Public URL: $PUBLIC_URL"
      echo ""
      break
    fi
    sleep 1
  done
  tail -f "$TUNNEL_LOG_FILE" &
  LOG_TAIL_PID=$!
  wait "$TUNNEL_PID"
fi
