#!/usr/bin/env bash
# Yuanyi-Pi prod 服务管理脚本（按需启停，非开机自启）
#
# 定位：用户用时启动，不用时停止；不注册 launchd / 开机自启（避免常驻消耗资源）。
# 管理两个服务：
#   - personal-runtime（8770，数据 ~/.pi/agent / ~/.yuanyi-pi）
#   - pi-web（30141，Gateway 模式）
#
# 用法：
#   services.sh start [--wechat]  启动 runtime + web（--wechat 启用微信 Channel）
#   services.sh stop              停止两个服务
#   services.sh restart [--wechat] 重启
#   services.sh status            查看状态（含健康检查）
#   services.sh log [runtime|web]  tail 日志
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROD_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="$PROD_ROOT/personal-runtime"
WEB_DIR="$PROD_ROOT/pi-web"

RT_PORT=8770
WEB_PORT=30141
RT_LOG="/tmp/personal-runtime-prod.log"
WEB_LOG="/tmp/pi-web-prod.log"

runtime_pid() { lsof -tiTCP:"$RT_PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
web_pid() { lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
runtime_ok() { curl -fsS -m 2 "http://127.0.0.1:$RT_PORT/health" 2>/dev/null | grep -q '"service":"personal-runtime"'; }
web_ok() { curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$WEB_PORT/" 2>/dev/null; }

start_runtime() {
  local wechat=0
  if [ "${1:-}" = "--wechat" ]; then wechat=1; fi
  if [ -n "$(runtime_pid)" ]; then
    echo "personal-runtime already running (pid $(runtime_pid))"
    return 0
  fi
  echo "starting personal-runtime (port $RT_PORT)..."
  ( cd "$RUNTIME_DIR" && \
    YUANYI_PI_WECHAT_ENABLED="$wechat" \
    nohup node --import tsx src/index.ts > "$RT_LOG" 2>&1 & )
  sleep 3
  if runtime_ok; then
    if [ "$wechat" = "1" ]; then
      echo "personal-runtime started (pid $(runtime_pid)) -> http://127.0.0.1:$RT_PORT (wechat enabled)"
    else
      echo "personal-runtime started (pid $(runtime_pid)) -> http://127.0.0.1:$RT_PORT"
    fi
  else
    echo "personal-runtime FAILED, check $RT_LOG"
    return 1
  fi
}

start_web() {
  if [ -n "$(web_pid)" ]; then
    echo "pi-web already running (pid $(web_pid))"
    return 0
  fi
  echo "starting pi-web (port $WEB_PORT, gateway mode)..."
  ( cd "$WEB_DIR" && \
    PERSONAL_GATEWAY_ENABLED=1 PI_WEB_PORT="$WEB_PORT" \
    nohup node_modules/.bin/next start -H 127.0.0.1 -p "$WEB_PORT" > "$WEB_LOG" 2>&1 & )
  sleep 5
  if web_ok; then
    echo "pi-web started (pid $(web_pid)) -> http://127.0.0.1:$WEB_PORT"
  else
    echo "pi-web FAILED, check $WEB_LOG"
    return 1
  fi
}

stop_service() {
  local name="$1" port="$2" pid
  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    echo "$name: not running"
    return 0
  fi
  echo "$name: stopping (pid $pid)..."
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
  echo "$name: stopped"
}

status() {
  local rt_ok web_ok
  if [ -n "$(runtime_pid)" ] && runtime_ok; then rt_ok="✅ running (pid $(runtime_pid)) http://127.0.0.1:$RT_PORT"; else rt_ok="⛔ not running"; fi
  if [ -n "$(web_pid)" ] && web_ok; then web_ok="✅ running (pid $(web_pid)) http://127.0.0.1:$WEB_PORT"; else web_ok="⛔ not running"; fi
  echo "personal-runtime: $rt_ok"
  echo "pi-web:           $web_ok"
}

case "${1:-}" in
  start)
    start_runtime "${2:-}"
    start_web
    ;;
  stop)
    stop_service "pi-web" "$WEB_PORT"
    stop_service "personal-runtime" "$RT_PORT"
    ;;
  restart)
    stop_service "pi-web" "$WEB_PORT"
    stop_service "personal-runtime" "$RT_PORT"
    sleep 1
    start_runtime "${2:-}"
    start_web
    ;;
  status) status ;;
  log)
    case "${2:-}" in
      web) tail -f "$WEB_LOG" ;;
      runtime) tail -f "$RT_LOG" ;;
      *) tail -f "$RT_LOG" "$WEB_LOG" ;;
    esac
    ;;
  *) echo "usage: $0 {start [--wechat]|stop|restart [--wechat]|status|log [runtime|web]}" ;;
esac
