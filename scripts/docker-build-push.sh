#!/usr/bin/env bash
# Build and push a Docker image for this project
# - Defaults to linux/amd64 for Apple Silicon compatibility
# - Uses docker buildx when available; falls back to classic docker build + push
# - Optional registry login via DOCKER_USERNAME/DOCKER_PASSWORD/DOCKER_REGISTRY

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage:
  scripts/docker-build-push.sh -i IMAGE[:TAG] [options]

Options:
  -i, --image IMAGE[:TAG]   Target image (e.g., username/kanban or registry/namespace/app:tag) [required]
  -t, --tag TAG             Tag to use when IMAGE does not include a tag (default: git short sha or 'latest')
  -f, --file DOCKERFILE     Path to Dockerfile (default: ./Dockerfile)
  -c, --context DIR         Build context directory (default: .)
  -p, --platform PLATFORMS  Platform(s) to build for (default: linux/amd64)
  -a, --build-arg ARG       Build arg (repeatable), e.g. -a NODE_ENV=production
      --no-cache            Disable build cache
      --load                Load result into local docker engine (implies no push)
      --push                Force push when using buildx (default)
  -h, --help                Show this help

Environment variables (optional):
  DOCKER_USERNAME           Registry username for login
  DOCKER_PASSWORD           Registry password/token for login
  DOCKER_REGISTRY           Registry to login (e.g., docker.io, ghcr.io)

Examples:
  scripts/docker-build-push.sh -i yourname/kanban -t latest
  scripts/docker-build-push.sh -i yourorg/kanban -p linux/amd64,linux/arm64
  DOCKER_USERNAME=foo DOCKER_PASSWORD=bar scripts/docker-build-push.sh -i ghcr.io/yourorg/kanban:$(git rev-parse --short HEAD)
EOF
}

IMAGE=""
TAG=""
DOCKERFILE="./Dockerfile"
CONTEXT="."
PLATFORMS="linux/amd64"
PUSH_MODE="--push"   # buildx only; classic docker uses docker push explicitly
NO_CACHE=""
BUILD_ARGS=()

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        -i|--image)
            IMAGE="${2:-}"; shift 2 ;;
        -t|--tag)
            TAG="${2:-}"; shift 2 ;;
        -f|--file)
            DOCKERFILE="${2:-}"; shift 2 ;;
        -c|--context)
            CONTEXT="${2:-}"; shift 2 ;;
        -p|--platform)
            PLATFORMS="${2:-}"; shift 2 ;;
        -a|--build-arg)
            BUILD_ARGS+=("${2:-}"); shift 2 ;;
        --no-cache)
            NO_CACHE="--no-cache"; shift ;;
        --load)
            PUSH_MODE="--load"; shift ;;
        --push)
            PUSH_MODE="--push"; shift ;;
        -h|--help)
            usage; exit 0 ;;
        --)
            shift; break ;;
        -*)
            echo "Unknown option: $1" >&2; usage; exit 1 ;;
        *)
            # positional IMAGE fallback if not set yet
            if [[ -z "$IMAGE" ]]; then IMAGE="$1"; shift; else echo "Unexpected argument: $1" >&2; usage; exit 1; fi ;;
    esac
done

if [[ -z "$IMAGE" ]]; then
    echo "Error: --image is required" >&2
    usage
    exit 1
fi

# Derive tag if not included and not provided
if [[ "$IMAGE" == *:* ]]; then
    IMAGE_REF="$IMAGE"
else
    if [[ -z "$TAG" ]]; then
        if command -v git >/dev/null 2>&1; then
            TAG="$(git rev-parse --short HEAD 2>/dev/null || true)"
            TAG="${TAG:-latest}"
        else
            TAG="latest"
        fi
    fi
    IMAGE_REF="${IMAGE}:${TAG}"
fi

# Optional registry login
maybe_login() {
    # Determine target registry from IMAGE if it looks like a registry, else from DOCKER_REGISTRY
    local reg_from_image
    reg_from_image="$(awk -F/ '{print $1}' <<< "$IMAGE")"
    local target_registry=""
    if [[ "$reg_from_image" == *.* || "$reg_from_image" == *:* || "$reg_from_image" == "localhost" ]]; then
        target_registry="$reg_from_image"
    elif [[ -n "${DOCKER_REGISTRY:-}" ]]; then
        target_registry="$DOCKER_REGISTRY"
    fi

    if [[ -n "${DOCKER_USERNAME:-}" && -n "${DOCKER_PASSWORD:-}" && -n "$target_registry" ]]; then
        echo "Logging in to $target_registry as $DOCKER_USERNAME ..."
        printf '%s' "$DOCKER_PASSWORD" | docker login "$target_registry" --username "$DOCKER_USERNAME" --password-stdin
    else
        echo "Skipping docker login (set DOCKER_USERNAME, DOCKER_PASSWORD, and DOCKER_REGISTRY to enable)."
    fi
}

# Build args assembly
EXTRA_ARGS=()
for ba in "${BUILD_ARGS[@]:-}"; do
    [[ -n "$ba" ]] && EXTRA_ARGS+=(--build-arg "$ba")
done

# Build using buildx if available; otherwise fallback
run_buildx() {
    echo "[buildx] Building $IMAGE_REF (platforms: $PLATFORMS) ..."
    local created_builder=""
    if ! docker buildx ls >/dev/null 2>&1; then
        echo "docker buildx not available" >&2
        return 1
    fi
    # Try ensure a usable builder (some environments need an explicit builder)
    local tmp_builder="kanbanx-$(date +%s)"
    if docker buildx create --name "$tmp_builder" --driver docker-container --use >/dev/null 2>&1; then
        created_builder="$tmp_builder"
    else
        echo "Using existing buildx builder"
    fi
    # Cleanup builder on exit if we created it
    if [[ -n "$created_builder" ]]; then
        trap 'docker buildx rm -f "$created_builder" >/dev/null 2>&1 || true' EXIT
    fi

    set -x
    docker buildx build \
        "${EXTRA_ARGS[@]}" \
        ${NO_CACHE:+$NO_CACHE} \
        --platform "$PLATFORMS" \
        -f "$DOCKERFILE" \
        -t "$IMAGE_REF" \
        "$PUSH_MODE" \
        "$CONTEXT"
    { set +x; } 2>/dev/null || set +x
}

run_classic() {
    echo "[docker] Building $IMAGE_REF ..."
    set -x
    docker build ${NO_CACHE:+$NO_CACHE} \
        "${EXTRA_ARGS[@]}" \
        -f "$DOCKERFILE" -t "$IMAGE_REF" "$CONTEXT"
    { set +x; } 2>/dev/null || set +x

    if [[ "$PUSH_MODE" == "--push" ]]; then
        echo "Pushing $IMAGE_REF ..."
        set -x
        docker push "$IMAGE_REF"
        { set +x; } 2>/dev/null || set +x
    else
        echo "Loaded image into local docker engine (no push)."
    fi
}

main() {
    echo "Image:        $IMAGE_REF"
    echo "Dockerfile:   $DOCKERFILE"
    echo "Context:      $CONTEXT"
    echo "Platforms:    $PLATFORMS"
    echo "Mode:         ${PUSH_MODE#--}"

    maybe_login

    if run_buildx; then
        echo "Build (buildx) finished."
    else
        echo "Falling back to classic docker build ..."
        run_classic
    fi
}

main "$@"