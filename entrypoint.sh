#!/bin/sh
# entrypoint.sh — run DB migrations then start the app.
# Using `exec` hands PID 1 to node so Docker signals (SIGTERM) are forwarded correctly.
set -e

echo "[entrypoint] Running database migrations…"
node dist/scripts/migrate.js

echo "[entrypoint] Starting ninja-planner…"
exec node dist/index.js
