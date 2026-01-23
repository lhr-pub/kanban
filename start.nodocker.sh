#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PID_FILE="${PID_FILE:-$DIR/run/kanban.pid}"
LOG_FILE="${LOG_FILE:-$DIR/logs/kanban.log}"
ENV_FILE="${ENV_FILE:-$DIR/.env}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"

usage() {
    cat <<'EOF'
Usage: ./start.nodocker.sh [command]

Commands:
  install           Install dependencies (npm install)
  install-prod      Install production deps only (npm ci --omit=dev)
  build-css         Build merged CSS (requires dev deps)
  start             Start server in background
  stop              Stop server
  restart           Restart server
  status            Show running status
  logs              Tail logs
  help              Show this help

Environment:
  PID_FILE          Override PID file path (default: ./run/kanban.pid)
  LOG_FILE          Override log path (default: ./logs/kanban.log)
  ENV_FILE          Override env file path (default: ./.env)
  NODE_BIN          Override node binary (default: node)
  NPM_BIN           Override npm binary (default: npm)

Examples:
  ./start.nodocker.sh install
  ./start.nodocker.sh build-css
  ./start.nodocker.sh start
  ./start.nodocker.sh logs
EOF
}

ensure_dirs() {
    mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
}

is_running() {
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid="$(cat "$PID_FILE")"
        if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

cmd_install() {
    "$NPM_BIN" install
}

cmd_install_prod() {
    if [[ -f "$DIR/package-lock.json" ]]; then
        "$NPM_BIN" ci --omit=dev
    else
        "$NPM_BIN" install --omit=dev
    fi
}

cmd_build_css() {
    "$NPM_BIN" run build:css:min
}

cmd_start() {
    ensure_dirs
    if is_running; then
        echo "Already running (pid $(cat "$PID_FILE"))."
        return 0
    fi
    if [[ ! -f "$ENV_FILE" ]]; then
        echo "Warning: .env not found at $ENV_FILE (dotenv will skip)." >&2
    fi
    export NODE_ENV="${NODE_ENV:-production}"
    nohup "$NODE_BIN" -r dotenv/config server.js >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Started (pid $(cat "$PID_FILE")). Logs: $LOG_FILE"
}

cmd_stop() {
    if ! is_running; then
        echo "Not running."
        rm -f "$PID_FILE"
        return 0
    fi
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..30}; do
        if ! kill -0 "$pid" >/dev/null 2>&1; then
            rm -f "$PID_FILE"
            echo "Stopped."
            return 0
        fi
        sleep 0.1
    done
    echo "Force stopping (pid $pid)..."
    kill -9 "$pid" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
}

cmd_status() {
    if is_running; then
        echo "Running (pid $(cat "$PID_FILE"))."
        return 0
    fi
    echo "Stopped."
    return 1
}

cmd_logs() {
    ensure_dirs
    touch "$LOG_FILE"
    tail -n 200 -f "$LOG_FILE"
}

CMD="${1:-help}"
shift || true

case "$CMD" in
    install)
        cmd_install
        ;;
    install-prod)
        cmd_install_prod
        ;;
    build-css)
        cmd_build_css
        ;;
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_stop
        cmd_start
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        echo "Unknown command: $CMD" >&2
        echo
        usage
        exit 1
        ;;
esac
