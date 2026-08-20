#!/usr/bin/env bash
# pi-web 管理脚本（生产模式，Next.js standalone start）— Yuanyi-Pi prod 版
# 用法：
#   pi-web.sh start    启动（后台 nohup）
#   pi-web.sh stop     停止
#   pi-web.sh status   查看状态
#   pi-web.sh restart  重启
#   pi-web.sh log      查看日志（tail -f）
set -euo pipefail

APP_DIR="/Users/yuanyi/Desktop/AI/16_Pi-Yuanyi/Pi/Yuanyi-Pi-prod/pi-web"
LOG_FILE="/tmp/pi-web-prod.log"
PID_FILE="/tmp/pi-web.pid"
PORT=30141

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "pi-web already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  cd "$APP_DIR"
  nohup npm start > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 3
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
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
  # 兜底：停掉所有 30141 的 next 进程（含旧目录实例）
  pkill -f "next start -H 127.0.0.1 -p $PORT" 2>/dev/null || true
  pkill -f "next-server" 2>/dev/null || true
  sleep 1
  echo "pi-web stopped"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running (pid $(cat "$PID_FILE")) -> http://127.0.0.1:$PORT"
  elif pgrep -f "next start -H 127.0.0.1 -p $PORT" >/dev/null 2>&1; then
    echo "running (no pid file) -> http://127.0.0.1:$PORT"
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
