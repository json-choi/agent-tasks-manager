#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TASK_MANAGER_DIR:-$HOME/.agent-tasks-manager}"
PORT="${PORT:-3011}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:${PORT}}"
INSTALL_MODE="${TASK_MANAGER_INSTALL_MODE:-local}"
AUTH_SECRET="${BETTER_AUTH_SECRET:-}"

if [ -z "$AUTH_SECRET" ] && [ -f "$ROOT_DIR/.env" ]; then
  AUTH_SECRET="$(grep '^BETTER_AUTH_SECRET=' "$ROOT_DIR/.env" | sed 's/^BETTER_AUTH_SECRET=//' || true)"
fi

if [ -z "$AUTH_SECRET" ]; then
  if command -v openssl >/dev/null 2>&1; then
    AUTH_SECRET="$(openssl rand -hex 32)"
  else
    AUTH_SECRET="replace-with-a-random-secret-at-least-32-characters"
  fi
fi

mkdir -p "$ROOT_DIR"
cd "$ROOT_DIR"

if [ ! -f docker-compose.yml ]; then
  echo "Copy this repository into $ROOT_DIR before running install.sh, or set TASK_MANAGER_DIR to the repository path."
  exit 1
fi

cat > .env <<EOF
DATA_DIR=${DATA_DIR:-$ROOT_DIR/data}
PORT=${PORT}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
BETTER_AUTH_SECRET=${AUTH_SECRET}
TASK_MANAGER_INSTALL_MODE=${INSTALL_MODE}
EOF

if [ "$INSTALL_MODE" = "docker" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for TASK_MANAGER_INSTALL_MODE=docker."
    exit 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required for TASK_MANAGER_INSTALL_MODE=docker."
    exit 1
  fi

  docker compose up -d --build
else
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is required for local mode. Install Bun or set TASK_MANAGER_INSTALL_MODE=docker."
    exit 1
  fi

  bun install
  bun run build
fi

echo "Setup URL: ${PUBLIC_BASE_URL}/setup"
echo "Health:    ${PUBLIC_BASE_URL}/health"

if [ "$INSTALL_MODE" = "docker" ]; then
  echo "ATM is starting."
else
  echo "ATM is installed."
  echo "Run app+worker: DATA_DIR=${ROOT_DIR}/data PORT=${PORT} PUBLIC_BASE_URL=${PUBLIC_BASE_URL} bun bin/task-manager.js run --mode local --dir ${ROOT_DIR}"
fi
