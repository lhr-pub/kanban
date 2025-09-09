#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

REMOTE_HOST="${REMOTE_HOST:-root@s1}"
REMOTE_DIR="${REMOTE_DIR:-kanban}"
IMAGE_REPO="${IMAGE_REPO:-xj-01-harbor.d.run/xj-01-u-cdd1523c53fb/kanban}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
SSH_OPTS="${SSH_OPTS:-}"

usage() {
    cat <<EOF
Usage: ./remote.sh [options] <command> [args...]

Commands:
  deploy            Build+push image, then remote pull and start (up -d)
  refresh|update    Remote pull latest image and start (up -d)
  build|build-push  Buildx build and push image only
  start             Start services on remote (up -d)
  stop              Stop services on remote
  restart           Restart services on remote
  down              Stop and remove containers on remote
  pull              Pull images on remote
  ps|status         Show status on remote
  logs [svc]        Tail logs on remote (optionally a single service)
  help              Show this help

Options:
  -H <host>         SSH host (default: ${REMOTE_HOST})
  -D <dir>          Remote project directory (default: ${REMOTE_DIR})
  -I <image_repo>   Image repository (default: ${IMAGE_REPO})
  -T <tag>          Image tag (default: ${IMAGE_TAG})
  -P <platform>     Build platform (default: ${PLATFORM})
  -S <ssh_opts>     Extra SSH options, e.g. "-p 2222 -o StrictHostKeyChecking=accept-new"

Examples:
  ./remote.sh deploy
  ./remote.sh refresh
  ./remote.sh logs web
  ./remote.sh -H root@server -D /srv/kanban deploy
  IMAGE_TAG=v2025-01-01 ./remote.sh deploy
EOF
}

while getopts ":H:D:I:T:P:S:h" opt; do
    case "$opt" in
        H) REMOTE_HOST="$OPTARG" ;;
        D) REMOTE_DIR="$OPTARG" ;;
        I) IMAGE_REPO="$OPTARG" ;;
        T) IMAGE_TAG="$OPTARG" ;;
        P) PLATFORM="$OPTARG" ;;
        S) SSH_OPTS="$OPTARG" ;;
        h) usage; exit 0 ;;
        \?) echo "Unknown option: -$OPTARG" >&2; usage; exit 1 ;;
        :) echo "Option -$OPTARG requires an argument" >&2; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

CMD="${1:-deploy}"
if [[ $# -gt 0 ]]; then
    shift
fi

FULL_IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"

build_push() {
    echo "==> Building and pushing ${FULL_IMAGE} for ${PLATFORM}"
    docker buildx build --platform "${PLATFORM}" -t "${FULL_IMAGE}" . --push
}

remote() {
    local subcmd="$1"; shift || true
    echo "==> Remote ${subcmd} on ${REMOTE_HOST}:${REMOTE_DIR}"
    # shellcheck disable=SC2029
    ssh ${SSH_OPTS} "${REMOTE_HOST}" "cd '${REMOTE_DIR}' && ./start.sh ${subcmd} $*"
}

case "${CMD}" in
    deploy)
        build_push
        remote pull
        remote stop "$@"
        remote start "$@"
        ;;
    refresh|update)
        remote pull
        remote stop "$@"
        remote start "$@"
        ;;
    build|build-push|bp)
        build_push
        ;;
    start|stop|restart|down|pull|ps|status)
        remote "${CMD}" "$@"
        ;;
    logs)
        remote logs "$@"
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
