#!/usr/bin/env bash
# install.sh — build and start the DND Dashboard Docker container
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "$0")" && pwd)/docker-compose.yml"

check_deps() {
  for cmd in docker; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "ERROR: '$cmd' is not installed or not on PATH." >&2
      exit 1
    fi
  done

  if docker compose version &>/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose &>/dev/null; then
    COMPOSE="docker-compose"
  else
    echo "ERROR: Neither 'docker compose' nor 'docker-compose' is available." >&2
    exit 1
  fi
}

print_usage() {
  cat <<EOF
Usage: $0 [COMMAND]

Commands:
  start        Build (if needed) and start the container        (default)
  rebuild      Force a full image rebuild then start
  install-asr  Rebuild image with local Whisper ASR support (~6 GB)
               Optional: TORCH_EXTRA_INDEX=<url> for GPU torch
  stop         Stop the running container
  logs         Follow container logs
  status       Show container status
  help         Show this message
EOF
}

cmd_start() {
  echo "Starting DND Dashboard..."
  $COMPOSE -f "$COMPOSE_FILE" up -d
  echo ""
  echo "Dashboard running at http://localhost:8790"
}

cmd_rebuild() {
  echo "Rebuilding DND Dashboard image..."
  $COMPOSE -f "$COMPOSE_FILE" up -d --build
  echo ""
  echo "Dashboard running at http://localhost:8790"
}

cmd_install_asr() {
  echo "Rebuilding DND Dashboard image with local Whisper ASR support..."
  echo "This will download ~6 GB of Python/PyTorch packages. Please wait."
  echo ""
  local extra_args=()
  if [ -n "${TORCH_EXTRA_INDEX:-}" ]; then
    echo "Using custom torch index: $TORCH_EXTRA_INDEX"
    extra_args+=(--build-arg "TORCH_EXTRA_INDEX=$TORCH_EXTRA_INDEX")
  fi
  $COMPOSE -f "$COMPOSE_FILE" build \
    --build-arg INSTALL_WHISPER=true \
    "${extra_args[@]}" \
    dnd-dashboard
  $COMPOSE -f "$COMPOSE_FILE" up -d
  echo ""
  echo "Dashboard running at http://localhost:8790 (with local Whisper ASR)"
}

cmd_stop() {
  echo "Stopping DND Dashboard..."
  $COMPOSE -f "$COMPOSE_FILE" down
}

cmd_logs() {
  $COMPOSE -f "$COMPOSE_FILE" logs -f
}

cmd_status() {
  $COMPOSE -f "$COMPOSE_FILE" ps
}

check_deps

case "${1:-start}" in
  start)       cmd_start       ;;
  rebuild)     cmd_rebuild     ;;
  install-asr) cmd_install_asr ;;
  stop)        cmd_stop        ;;
  logs)        cmd_logs        ;;
  status)      cmd_status      ;;
  help|--help|-h) print_usage ;;
  *)
    echo "Unknown command: $1" >&2
    print_usage >&2
    exit 1
    ;;
esac
