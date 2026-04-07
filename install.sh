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
  start    Build (if needed) and start the container      (default)
  rebuild  Force a full image rebuild then start
  stop     Stop the running container
  logs     Follow container logs
  status   Show container status
  help     Show this message
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
  start)   cmd_start   ;;
  rebuild) cmd_rebuild ;;
  stop)    cmd_stop    ;;
  logs)    cmd_logs    ;;
  status)  cmd_status  ;;
  help|--help|-h) print_usage ;;
  *)
    echo "Unknown command: $1" >&2
    print_usage >&2
    exit 1
    ;;
esac
