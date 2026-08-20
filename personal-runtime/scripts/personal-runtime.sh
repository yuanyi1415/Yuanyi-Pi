#!/usr/bin/env bash
# personal-runtime 管理脚本（生产模式）— Yuanyi-Pi prod 版
# 用法：
#   personal-runtime.sh start [--wechat]  启动（后台 nohup；--wechat 启用微信 Channel）
#   personal-runtime.sh stop     停止
#   personal-runtime.sh status   查看状态
#   personal-runtime.sh restart  重启
#   personal-runtime.sh log      查看日志（tail -f）
set -euo pipefail

APP_DIR="/Users/yuanyi/Desktop/AI/16_Pi-Yuanyi/Pi/Yuanyi-Pi-prod/personal-runtime"
LOG_FILE="/tmp/personal-runtime-prod.log"
PID_FILE="/tmp/personal-runtime.pid"
PORT=8770
DATA_DIR="$HOME/.yuanyi-pi"
AGENT_DIR="$HOME/.pi/agent"

start() {
  local WECHAT=""
  if [ "${1:-}" = "--wechat" ]; then WECHAT=1; fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "personal-runtime already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  cd "$APP_DIR"
  YUANYI_PI_DATA_DIR="$DATA_DIR" \
  YUANYI_PI_AGENT_DIR="$AGENT_DIR" \
  YUANYI_PI_WECHAT_ENABLED="${WECHAT:-0}" \
  nohup npm start > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 3
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "personal-runtime started (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT${WECHAT:+ (wechat enabled)}"
  else
    echo "personal-runtime failed to start, check $LOG_FILE"
    return 1
  fi
}

stop() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  pkill -f "tsx src/index.ts" 2>/dev/null || true
  sleep 1
  echo "personal-runtime stopped"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT"
  elif pgrep -f "tsx src/index.ts" >/dev/null 2>&1; then
    echo "running (no pid file)"
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
