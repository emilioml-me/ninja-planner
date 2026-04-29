#!/bin/bash
# Deploy ninja-planner to staging (ninja-planner.njn-stg.com)
set -euo pipefail

COMPOSE_FILE="docker-compose.stg.yml"
SECRETS_FILE="/srv/secrets/ninja-planner.stg.env"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"

echo "==> Checking secrets file..."
if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "ERROR: $SECRETS_FILE not found."
  exit 1
fi

VITE_CLERK_PUBLISHABLE_KEY=$(grep -E '^VITE_CLERK_PUBLISHABLE_KEY=' "$SECRETS_FILE" | cut -d= -f2-)
if [[ -z "$VITE_CLERK_PUBLISHABLE_KEY" ]]; then
  echo "ERROR: VITE_CLERK_PUBLISHABLE_KEY not set in $SECRETS_FILE"
  exit 1
fi
export VITE_CLERK_PUBLISHABLE_KEY

echo "==> Pulling latest code..."
git pull origin main

echo "==> Building image..."
docker compose -f "$COMPOSE_FILE" build --no-cache

echo "==> Stopping old container..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans

echo "==> Starting container..."
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for health check..."
sleep 5
docker compose -f "$COMPOSE_FILE" ps

echo "==> Done. ninja-planner staging is up at https://ninja-planner.njn-stg.com"
