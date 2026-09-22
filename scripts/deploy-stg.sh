#!/bin/bash
# Deploy ninja-planner to staging (ninja-planner.njn-stg.com)
#
# The whole script lives inside main() and is only invoked on the last line, so bash has parsed
# every line before `git pull` can rewrite this file. After the pull we re-exec the (possibly
# updated) script with DEPLOY_STG_PULLED=1 so the rest of the deploy always runs the new version.
set -euo pipefail

main() {
  local COMPOSE_FILE="docker-compose.stg.yml"
  local SECRETS_FILE="/srv/secrets/ninja-planner.stg.env"
  local CONTAINER="ninja-planner-stg"
  local HEALTH_URL="http://127.0.0.1:3208/health"
  local HEALTH_TIMEOUT=60
  local APP_DIR
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  cd "$APP_DIR"

  if [[ "${DEPLOY_STG_PULLED:-}" != "1" ]]; then
    echo "==> Pulling latest code..."
    git pull origin main
    DEPLOY_STG_PULLED=1 exec bash "$APP_DIR/scripts/deploy-stg.sh" "$@"
  fi

  echo "==> Checking secrets file..."
  if [[ ! -f "$SECRETS_FILE" ]]; then
    echo "ERROR: $SECRETS_FILE not found."
    exit 1
  fi

  local VITE_CLERK_PUBLISHABLE_KEY
  VITE_CLERK_PUBLISHABLE_KEY=$(grep -E '^VITE_CLERK_PUBLISHABLE_KEY=' "$SECRETS_FILE" | cut -d= -f2- || true)
  if [[ -z "$VITE_CLERK_PUBLISHABLE_KEY" ]]; then
    echo "ERROR: VITE_CLERK_PUBLISHABLE_KEY not set in $SECRETS_FILE"
    exit 1
  fi
  export VITE_CLERK_PUBLISHABLE_KEY

  echo "==> Building image..."
  docker compose -f "$COMPOSE_FILE" build --no-cache

  echo "==> Stopping old container..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans

  echo "==> Starting container..."
  docker compose -f "$COMPOSE_FILE" up -d

  echo "==> Waiting up to ${HEALTH_TIMEOUT}s for $HEALTH_URL ..."
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    local state
    state=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
    if [[ "$state" != "running" ]]; then
      # Migrations run before the app starts; a failed migration exits the container.
      if [[ "$state" == "exited" || "$state" == "dead" || "$state" == "missing" ]]; then
        echo "ERROR: container is $state"
        docker compose -f "$COMPOSE_FILE" logs --tail=100 || true
        exit 1
      fi
    elif curl -fsS --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
      docker compose -f "$COMPOSE_FILE" ps
      echo "==> Done. ninja-planner staging is up at https://ninja-planner.njn-stg.com"
      return 0
    fi
    sleep 3
  done

  echo "ERROR: $HEALTH_URL did not respond within ${HEALTH_TIMEOUT}s"
  docker compose -f "$COMPOSE_FILE" ps || true
  docker compose -f "$COMPOSE_FILE" logs --tail=100 || true
  exit 1
}

main "$@"
