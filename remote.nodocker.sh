#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

REMOTE_HOST="${REMOTE_HOST:-root@s1}"
REMOTE_DIR="${REMOTE_DIR:-kanban}"
SSH_OPTS="${SSH_OPTS:-}"
ENV_FILE="${ENV_FILE:-.env}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
DOCKER_VOLUME="${DOCKER_VOLUME:-kanban_data}"
DOCKER_CONTAINER="${DOCKER_CONTAINER:-kanban}"
SUDO="${SUDO:-}"

usage() {
    cat <<EOF
Usage: ./remote.nodocker.sh [options] <command> [args...]

Commands:
  sync              Rsync project to remote (excludes data/, node_modules/)
  install           Remote npm install
  install-prod      Remote npm ci --omit=dev
  build-css         Remote build css (npm run build:css:min)
  import-docker-data  Copy Docker volume data into remote ./data
  link-docker-data    Symlink Docker volume to remote ./data
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
  -B <docker_bin>   Docker binary (default: ${DOCKER_BIN})
  -V <volume>       Docker volume name (default: ${DOCKER_VOLUME})
  -C <container>    Docker container name (default: ${DOCKER_CONTAINER})
  -U <sudo>         Sudo prefix for remote docker (e.g. "sudo -n")

Examples:
  ./remote.nodocker.sh sync
  ./remote.nodocker.sh deploy
  ./remote.nodocker.sh import-docker-data
  ./remote.nodocker.sh link-docker-data
  ./remote.nodocker.sh logs
  ./remote.nodocker.sh -H root@server -D /srv/kanban deploy
EOF
}

while getopts ":H:D:S:B:V:C:U:h" opt; do
    case "$opt" in
        H) REMOTE_HOST="$OPTARG" ;;
        D) REMOTE_DIR="$OPTARG" ;;
        S) SSH_OPTS="$OPTARG" ;;
        B) DOCKER_BIN="$OPTARG" ;;
        V) DOCKER_VOLUME="$OPTARG" ;;
        C) DOCKER_CONTAINER="$OPTARG" ;;
        U) SUDO="$OPTARG" ;;
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

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\"'\"'/g")"
}

remote() {
    local subcmd="$1"; shift || true
    local env_prefix
    env_prefix="DOCKER_BIN=$(shell_quote "$DOCKER_BIN")"
    env_prefix+=" DOCKER_VOLUME=$(shell_quote "$DOCKER_VOLUME")"
    env_prefix+=" DOCKER_CONTAINER=$(shell_quote "$DOCKER_CONTAINER")"
    env_prefix+=" SUDO=$(shell_quote "$SUDO")"
    # shellcheck disable=SC2029
    ssh ${SSH_OPTS} "${REMOTE_HOST}" "cd '${REMOTE_DIR}' && ${env_prefix} ./start.nodocker.sh ${subcmd} $*"
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
    import-docker-data)
        remote import-docker-data
        ;;
    link-docker-data)
        remote link-docker-data
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
