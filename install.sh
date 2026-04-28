#!/usr/bin/env bash
set -euo pipefail

DEFAULT_ROOT_DIR="$HOME/.agent-task-manager"
if [ -n "${TASK_MANAGER_DIR:-}" ]; then
  ROOT_DIR="$TASK_MANAGER_DIR"
else
  ROOT_DIR="$DEFAULT_ROOT_DIR"
fi
PORT="${PORT:-3011}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:${PORT}}"
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

if [ ! -f package.json ] || [ ! -f bin/task-manager.js ]; then
  echo "Copy this repository into $ROOT_DIR before running install.sh, or set TASK_MANAGER_DIR to the repository path."
  exit 1
fi

cat > .env <<EOF
DATA_DIR=${DATA_DIR:-$ROOT_DIR/data}
PORT=${PORT}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
BETTER_AUTH_SECRET=${AUTH_SECRET}
EOF

append_env_if_set() {
  local key="$1"
  local value="${!key:-}"
  if [ -n "$value" ]; then
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

for key in \
  GITHUB_TOKEN \
  GITHUB_WEBHOOK_SECRET \
  OPENCLAW_GITHUB_WEBHOOK_SECRET \
  TASK_MANAGER_BOOTSTRAP \
  TASK_MANAGER_BOOTSTRAP_ON_START \
  TASK_MANAGER_BOOTSTRAP_STRICT \
  TASK_MANAGER_ADMIN_EMAIL \
  TASK_MANAGER_ADMIN_PASSWORD \
  TASK_MANAGER_OPENCLAW_WORKSPACE \
  TASK_MANAGER_OPENCLAW_CLI \
  TASK_MANAGER_OPENCLAW_RUN_RELOAD \
  TASK_MANAGER_OPENCLAW_FORCE_INSTALL \
  TASK_MANAGER_OPENCLAW_REGENERATE_TOKEN \
  TASK_MANAGER_SLACK_PERMISSIONS_REVIEWED \
  TASK_MANAGER_PUBLIC_ACCESS_MODE \
  TASK_MANAGER_PUBLIC_URL \
  TASK_MANAGER_LOCAL_SERVICE_URL \
  TASK_MANAGER_CLOUDFLARE_TUNNEL_NAME \
  TASK_MANAGER_CLOUDFLARE_TUNNEL_TOKEN \
  TASK_MANAGER_CLOUDFLARE_INSTALL_COMMAND \
  TASK_MANAGER_PUBLIC_ACCESS_PROTECTED
do
  append_env_if_set "$key"
done

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required to install ATM."
  exit 1
fi

bun install
bun run build

echo "Setup URL: ${PUBLIC_BASE_URL}/setup"
echo "Health:    ${PUBLIC_BASE_URL}/health"
echo "ATM is installed."
echo "Run app+worker: DATA_DIR=${ROOT_DIR}/data PORT=${PORT} PUBLIC_BASE_URL=${PUBLIC_BASE_URL} bun bin/task-manager.js run --dir ${ROOT_DIR}"
echo "One-command setup: bun bin/task-manager.js setup --dir ${ROOT_DIR} --port ${PORT} --open"
