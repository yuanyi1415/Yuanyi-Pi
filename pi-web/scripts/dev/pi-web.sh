#!/usr/bin/env bash
# pi-web 开发环境管理脚本；prod 不使用此 launcher。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="/tmp/pi-web-dev.log"
PID_FILE="/tmp/pi-web-dev.pid"
PORT="${PI_WEB_PORT:-30142}"
GATEWAY_URL="${PERSONAL_GATEWAY_URL:-http://127.0.0.1:8771}"

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "pi-web already running (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT"
    return 0
  fi
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/" >/dev/null; then
    echo "cannot start dev pi-web: port $PORT is occupied"
    return 1
  fi
  cd "$APP_DIR"
  PERSONAL_GATEWAY_ENABLED=1 PERSONAL_GATEWAY_URL="$GATEWAY_URL" \
  PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi-dev/agent}" \
  nohup "$APP_DIR/node_modules/.bin/next" start -H 127.0.0.1 -p "$PORT" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 3
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null && curl -fsS -m 2 "http://127.0.0.1:$PORT/" >/dev/null; then
    echo "pi-web started (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT"
  else
    echo "pi-web failed to start, check $LOG_FILE"
    return 1
  fi
}

stop() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  echo "pi-web stopped"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT"
  else
    echo "not running"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) status ;;
  log) tail -f "$LOG_FILE" ;;
  *) echo "usage: $0 {start|stop|restart|status|log}" ;;
esac
