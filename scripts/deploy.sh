#!/bin/bash
# /srv/scripts/deploy.sh — called by Jenkins to deploy ninja-planner on the prod server.
#
# Usage: bash /srv/scripts/deploy.sh <app-name> <version-tag>
#   app-name    : ninja-planner
#   version-tag : e.g. v1.2.3
#
# Prerequisites on the server:
#   - Docker + docker compose plugin installed
#   - docker login ghcr.io already done (or GHCR_PAT exported)
#   - /srv/secrets/plan-ninja.env present
#   - docker network ninja-internal exists
#   - docker-compose.prod.saas.yml present at APP_DIR
set -euo pipefail

APP_NAME="${1:?Usage: deploy.sh <app-name> <version>}"
VERSION="${2:?Usage: deploy.sh <app-name> <version>}"
APP_DIR="/srv/apps/${APP_NAME}"
COMPOSE_FILE="${APP_DIR}/docker-compose.prod.saas.yml"
IMAGE="ghcr.io/emilioml-me/ninja-planner"

echo "==> Deploying ${APP_NAME} ${VERSION} to production"

# ── 1. Ensure app directory exists ────────────────────────────────────────────
if [[ ! -d "${APP_DIR}" ]]; then
  echo "==> Cloning repo into ${APP_DIR}"
  git clone https://github.com/emilioml-me/ninja-planner.git "${APP_DIR}"
fi

cd "${APP_DIR}"

# ── 2. Pull latest compose file ───────────────────────────────────────────────
echo "==> Updating compose file from repo"
git fetch --tags origin
git checkout "${VERSION}" -- docker-compose.prod.saas.yml

# ── 3. Pull the versioned image ───────────────────────────────────────────────
echo "==> Pulling ${IMAGE}:${VERSION}"
docker pull "${IMAGE}:${VERSION}"

# Pin the compose file to this exact version (avoid accidental :latest drift)
export IMAGE_TAG="${VERSION}"

# ── 4. Re-tag as latest locally (for the compose file that references :latest) ─
docker tag "${IMAGE}:${VERSION}" "${IMAGE}:latest"

# ── 5. Ensure ninja-internal network exists ────────────────────────────────────
docker network inspect ninja-internal >/dev/null 2>&1 || \
  docker network create ninja-internal

# ── 6. Rolling restart ────────────────────────────────────────────────────────
echo "==> Stopping old container"
docker compose -f "${COMPOSE_FILE}" down --remove-orphans || true

echo "==> Starting new container (${VERSION})"
docker compose -f "${COMPOSE_FILE}" up -d

# ── 7. Health check ───────────────────────────────────────────────────────────
echo "==> Waiting for health check (up to 60s)…"
for i in $(seq 1 12); do
  sleep 5
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' ninja-planner 2>/dev/null || echo "missing")
  echo "    [${i}/12] Health: ${STATUS}"
  if [[ "${STATUS}" == "healthy" ]]; then
    echo "✅ ${APP_NAME} ${VERSION} is healthy"
    exit 0
  fi
done

echo "❌ Health check timed out — check container logs:"
docker logs --tail=50 ninja-planner
exit 1
