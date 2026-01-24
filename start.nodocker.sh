#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PID_FILE="${PID_FILE:-$DIR/run/kanban.pid}"
LOG_FILE="${LOG_FILE:-$DIR/logs/kanban.log}"
ENV_FILE="${ENV_FILE:-$DIR/.env}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com/}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
DOCKER_VOLUME="${DOCKER_VOLUME:-kanban_kanban_data}"
DOCKER_CONTAINER="${DOCKER_CONTAINER:-kanban}"
SUDO="${SUDO:-}"
SUDO_CMD=()
if [[ -n "$SUDO" ]]; then
    read -r -a SUDO_CMD <<< "$SUDO"
fi

sudo_run() {
    if [[ ${#SUDO_CMD[@]} -gt 0 ]]; then
        "${SUDO_CMD[@]}" "$@"
    else
        "$@"
    fi
}

docker_data_mount_for_container() {
    local container="$1"
    sudo_run "$DOCKER_BIN" inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$container" 2>/dev/null || true
}

detect_data_container() {
    local name mount
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        mount="$(docker_data_mount_for_container "$name")"
        if [[ -n "$mount" ]]; then
            echo "$name"
            return 0
        fi
    done < <(sudo_run "$DOCKER_BIN" ps -a --format '{{.Names}}')
    return 1
}

usage() {
    cat <<'EOF'
Usage: ./start.nodocker.sh [command]

Commands:
  install           Install dependencies (npm install)
  install-prod      Install production deps only (npm ci --omit=dev)
  build-css         Build merged CSS (requires dev deps)
  import-docker-data  Copy Docker volume data into ./data
  link-docker-data    Symlink Docker volume to ./data (stops container)
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
  NPM_REGISTRY      npm registry (default: https://registry.npmmirror.com/)
  DOCKER_BIN        Override docker binary (default: docker)
  DOCKER_VOLUME     Docker volume name (default: kanban_data)
  DOCKER_CONTAINER  Docker container name (default: kanban)
  SUDO              Prefix for privileged commands (e.g. "sudo -n")

Examples:
  ./start.nodocker.sh install
  ./start.nodocker.sh build-css
  ./start.nodocker.sh start
  ./start.nodocker.sh import-docker-data
  ./start.nodocker.sh link-docker-data
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

npm_major_version() {
    local version major
    version="$("$NPM_BIN" -v 2>/dev/null || true)"
    major="${version%%.*}"
    if [[ -z "$major" || ! "$major" =~ ^[0-9]+$ ]]; then
        major=0
    fi
    echo "$major"
}

read_lockfile_version() {
    if [[ ! -f "$DIR/package-lock.json" ]]; then
        return 0
    fi
    "$NODE_BIN" -e "try{const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package-lock.json','utf8'));if(pkg.lockfileVersion)console.log(pkg.lockfileVersion);}catch(e){}" 2>/dev/null || true
}

npm_cmd() {
    if [[ -n "$NPM_REGISTRY" ]]; then
        npm_config_registry="$NPM_REGISTRY" "$NPM_BIN" "$@"
        return
    fi
    "$NPM_BIN" "$@"
}

cmd_install() {
    local npm_major lockfile_version
    npm_major="$(npm_major_version)"
    lockfile_version="$(read_lockfile_version)"

    if [[ "$npm_major" -ge 9 ]] || [[ "${lockfile_version:-0}" -lt 3 ]]; then
        npm_cmd install
        return
    fi

    echo "Notice: npm ${npm_major} with lockfile v${lockfile_version} detected; installing without package-lock."
    npm_cmd install --no-package-lock
}

cmd_install_prod() {
    local npm_major lockfile_version
    npm_major="$(npm_major_version)"
    lockfile_version="$(read_lockfile_version)"

    if [[ "$npm_major" -ge 9 ]]; then
        if [[ -f "$DIR/package-lock.json" ]]; then
            npm_cmd ci --omit=dev
        else
            npm_cmd install --omit=dev
        fi
        return
    fi

    if [[ "$npm_major" -ge 7 ]]; then
        if [[ "${lockfile_version:-0}" -ge 3 ]]; then
            echo "Notice: npm ${npm_major} can't read lockfile v${lockfile_version}; using install without package-lock."
            npm_cmd install --omit=dev --no-package-lock
        elif [[ -f "$DIR/package-lock.json" ]]; then
            npm_cmd ci --omit=dev
        else
            npm_cmd install --omit=dev
        fi
        return
    fi

    echo "Notice: npm ${npm_major} detected; using legacy production install."
    npm_cmd install --only=prod --no-package-lock
}

cmd_build_css() {
    npm_cmd run build:css:min
}

docker_mountpoint() {
    if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
        echo "Error: docker not found (DOCKER_BIN=$DOCKER_BIN)." >&2
        exit 1
    fi
    local mount container
    if [[ -n "$DOCKER_VOLUME" ]]; then
        mount="$(sudo_run "$DOCKER_BIN" volume inspect "$DOCKER_VOLUME" --format '{{.Mountpoint}}' 2>/dev/null || true)"
    else
        mount=""
    fi
    if [[ -z "$mount" ]]; then
        if [[ -n "$DOCKER_CONTAINER" ]] && sudo_run "$DOCKER_BIN" inspect "$DOCKER_CONTAINER" >/dev/null 2>&1; then
            container="$DOCKER_CONTAINER"
        else
            container="$(detect_data_container || true)"
        fi
        if [[ -n "$container" ]]; then
            mount="$(docker_data_mount_for_container "$container")"
        fi
    fi
    if [[ -z "$mount" ]]; then
        echo "Error: docker data mount not found. Set DOCKER_VOLUME or DOCKER_CONTAINER." >&2
        exit 1
    fi
    echo "$mount"
}

cmd_import_docker_data() {
    local mount
    mount="$(docker_mountpoint)"

    if sudo_run "$DOCKER_BIN" ps -q --filter "name=^/${DOCKER_CONTAINER}$" | grep -q .; then
        echo "Stopping container ${DOCKER_CONTAINER}..."
        sudo_run "$DOCKER_BIN" stop "$DOCKER_CONTAINER"
    fi

    local ts backup
    ts="$(date +%Y%m%d%H%M%S)"
    if [[ -d "$DIR/data" && -n "$(ls -A "$DIR/data" 2>/dev/null)" ]]; then
        backup="$DIR/data.backup.$ts"
        mv "$DIR/data" "$backup"
        echo "Existing data moved to $backup"
    fi
    mkdir -p "$DIR/data"

    if command -v rsync >/dev/null 2>&1; then
        sudo_run rsync -a "$mount"/ "$DIR/data/"
    else
        sudo_run cp -a "$mount"/. "$DIR/data/"
    fi

    if [[ ${#SUDO_CMD[@]} -gt 0 ]]; then
        sudo_run chown -R "$(id -u)":"$(id -g)" "$DIR/data"
    fi
    echo "Imported docker volume '$DOCKER_VOLUME' to $DIR/data"
}

cmd_link_docker_data() {
    local mount
    mount="$(docker_mountpoint)"

    if sudo_run "$DOCKER_BIN" ps -q --filter "name=^/${DOCKER_CONTAINER}$" | grep -q .; then
        echo "Stopping container ${DOCKER_CONTAINER}..."
        sudo_run "$DOCKER_BIN" stop "$DOCKER_CONTAINER"
    fi

    local ts backup
    if [[ -e "$DIR/data" && ! -L "$DIR/data" ]]; then
        ts="$(date +%Y%m%d%H%M%S)"
        backup="$DIR/data.backup.$ts"
        mv "$DIR/data" "$backup"
        echo "Existing data moved to $backup"
    elif [[ -L "$DIR/data" ]]; then
        rm -f "$DIR/data"
    fi

    ln -s "$mount" "$DIR/data"
    echo "Linked docker volume '$DOCKER_VOLUME' to $DIR/data -> $mount"
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
    import-docker-data)
        cmd_import_docker_data
        ;;
    link-docker-data)
        cmd_link_docker_data
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
