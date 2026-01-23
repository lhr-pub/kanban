#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

REMOTE_HOST="${REMOTE_HOST:-root@s1}"
REMOTE_DIR="${REMOTE_DIR:-kanban}"
SSH_OPTS="${SSH_OPTS:-}"
ENV_FILE="${ENV_FILE:-.env}"

usage() {
    cat <<EOF
Usage: ./remote.nodocker.sh [options] <command> [args...]

Commands:
  sync              Rsync project to remote (excludes data/, node_modules/)
  install           Remote npm install
  install-prod      Remote npm ci --omit=dev
  build-css         Remote build css (npm run build:css:min)
  start             Remote start (./start.nodocker.sh start)
  stop              Remote stop
  restart           Remote restart
  status            Remote status
  logs              Tail logs on remote
  deploy            sync + install-prod + start
  help              Show this help

Options:
  -H <host>         SSH host (default: ${REMOTE_HOST})
  -D <dir>          Remote project directory (default: ${REMOTE_DIR})
  -S <ssh_opts>     Extra SSH options, e.g. "-p 2222 -o StrictHostKeyChecking=accept-new"

Examples:
  ./remote.nodocker.sh sync
  ./remote.nodocker.sh deploy
  ./remote.nodocker.sh logs
  ./remote.nodocker.sh -H root@server -D /srv/kanban deploy
EOF
}

while getopts ":H:D:S:h" opt; do
    case "$opt" in
        H) REMOTE_HOST="$OPTARG" ;;
        D) REMOTE_DIR="$OPTARG" ;;
        S) SSH_OPTS="$OPTARG" ;;
        h) usage; exit 0 ;;
        \?) echo "Unknown option: -$OPTARG" >&2; usage; exit 1 ;;
        :) echo "Option -$OPTARG requires an argument" >&2; usage; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

CMD="${1:-help}"
if [[ $# -gt 0 ]]; then
    shift
fi

remote() {
    local subcmd="$1"; shift || true
    # shellcheck disable=SC2029
    ssh ${SSH_OPTS} "${REMOTE_HOST}" "cd '${REMOTE_DIR}' && ./start.nodocker.sh ${subcmd} $*"
}

sync() {
    local exclude_args=(
        --exclude "node_modules/"
        --exclude "data/"
        --exclude ".git/"
        --exclude "logs/"
        --exclude "run/"
        --exclude ".env"
    )
    rsync -az --delete "${exclude_args[@]}" ./ "${REMOTE_HOST}:${REMOTE_DIR}/"
    if [[ -f "$ENV_FILE" ]]; then
        rsync -az "$ENV_FILE" "${REMOTE_HOST}:${REMOTE_DIR}/.env"
    fi
}

case "${CMD}" in
    sync)
        sync
        ;;
    install)
        remote install
        ;;
    install-prod)
        remote install-prod
        ;;
    build-css)
        remote build-css
        ;;
    start|stop|restart|status|logs)
        remote "${CMD}" "$@"
        ;;
    deploy)
        sync
        remote install-prod
        remote start
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        echo "Unknown command: ${CMD}" >&2
        echo
        usage
        exit 1
        ;;
esac
