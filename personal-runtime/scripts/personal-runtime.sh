#!/usr/bin/env bash
# personal-runtime 管理脚本（开发模式）
# 用法：
#   personal-runtime.sh start [--wechat]  启动（后台 nohup；--wechat 启用微信 Channel）
#   personal-runtime.sh stop     停止
#   personal-runtime.sh status   查看状态
#   personal-runtime.sh restart  重启
#   personal-runtime.sh log      查看日志（tail -f）
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="/tmp/personal-runtime-dev.log"
PID_FILE="/tmp/personal-runtime-dev.pid"
PORT=8771
DATA_DIR="$HOME/.pi-dev/.yuanyi-pi"
AGENT_DIR="$HOME/.pi-dev/agent"

start() {
  local WECHAT=""
  if [ "${1:-}" = "--wechat" ]; then WECHAT=1; fi
  if health_ok && pid_matches; then
    echo "personal-runtime already running (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT"
    return 0
  fi
  if health_ok || port_in_use; then
    echo "cannot start dev personal-runtime: port $PORT is occupied by an unknown process"
    return 1
  fi
  rm -f "$PID_FILE"
  cd "$APP_DIR"
  local runtime_entry="$APP_DIR/src/index.ts"
  YUANYI_PI_DATA_DIR="$DATA_DIR" \
  YUANYI_PI_AGENT_DIR="$AGENT_DIR" \
  YUANYI_PI_PORT="$PORT" \
  YUANYI_RUNTIME_ENV="dev" \
  YUANYI_PI_WECHAT_ENABLED="${WECHAT:-0}" \
  nohup node --import tsx "$runtime_entry" > "$LOG_FILE" 2>&1 &
  local runtime_pid=$!
  echo "$runtime_pid" > "$PID_FILE"
  for _ in {1..20}; do
    if pid_matches && health_ok; then break; fi
    sleep 0.25
  done
  if pid_matches && health_ok; then
    echo "personal-runtime started (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT${WECHAT:+ (wechat enabled)}"
  else
    kill "$runtime_pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "personal-runtime failed to start, check $LOG_FILE"
    return 1
  fi
}

health_ok() {
  curl -fsS -m 2 "http://127.0.0.1:$PORT/health" | grep -q '"service":"personal-runtime"'
}

port_in_use() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

pid_matches() {
  [ -f "$PID_FILE" ] || return 1
  local pid command
  pid="$(cat "$PID_FILE")"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  kill -0 "$pid" 2>/dev/null && {
    [[ "$command" == *"$APP_DIR/src/index.ts"* ]] ||
    [[ "$command" == *"personal-runtime/src/index.ts"* ]]
  }
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "personal-runtime is not running"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if ! pid_matches; then
    rm -f "$PID_FILE"
    echo "stale personal-runtime PID file removed"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "personal-runtime stopped"
      return 0
    fi
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "personal-runtime stopped"
}

status() {
  if pid_matches && health_ok; then
    echo "running (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT"
  else
    echo "not running"
  fi
}

case "${1:-}" in
  start) start "${2:-}" ;;
  stop) stop ;;
  restart) stop; sleep 1; start "${2:-}" ;;
  status) status ;;
  log) tail -f "$LOG_FILE" ;;
  *) echo "usage: $0 {start [--wechat]|stop|restart|status|log}" ;;
esac
