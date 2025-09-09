#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

COMPOSE_FILE="$DIR/docker-compose.prod.yml"

# Detect docker compose
if [[ -x "$DIR/docker-compose" ]]; then
    COMPOSE="$DIR/docker-compose"
elif docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    echo "Error: docker compose is not available (tried ./docker-compose, 'docker compose', and 'docker-compose')." >&2
    exit 1
fi

usage() {
    cat <<'EOF'
Usage: ./start.sh [command] [-- extra args]

Commands:
  up|start         Start services in background (detached)
  stop             Stop services
  restart          Restart services
  down             Stop and remove containers and networks
  pull             Pull latest images
  logs             Show and follow logs (optionally pass a service name)
  ps|status        Show container status
  help             Show this help

Examples:
  ./start.sh start
  ./start.sh restart
  ./start.sh logs
  ./start.sh logs web
  ./start.sh status
EOF
}

CMD="${1:-start}"
if [[ $# -gt 0 ]]; then
    shift
fi

compose() {
    # shellcheck disable=SC2086
    $COMPOSE -f "$COMPOSE_FILE" "$@"
}

case "$CMD" in
    up|start)
        compose up -d "$@"
        ;;
    stop)
        compose stop "$@"
        ;;
    restart)
        compose restart "$@"
        ;;
    down)
        compose down "$@"
        ;;
    pull)
        compose pull "$@"
        ;;
    logs)
        compose logs -f --tail=200 "$@"
        ;;
    ps|status)
        compose ps "$@"
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
