# ─── builder ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer-cached until package.json changes)
COPY package.json ./
RUN npm install

# Config files needed by both vite and tsc
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY tailwind.config.ts ./
COPY postcss.config.ts ./

# Source
COPY src ./src
COPY client ./client

# VITE_CLERK_PUBLISHABLE_KEY must be available at build time — it is baked
# into the React bundle by Vite.  Pass as build arg from docker-compose:
#   args:
#     VITE_CLERK_PUBLISHABLE_KEY: ${VITE_CLERK_PUBLISHABLE_KEY}
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}

RUN npm run build

# ─── production ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Production-only deps
COPY package.json ./
RUN npm install --omit=dev

# Compiled app (server + client bundle)
COPY --from=builder /app/dist ./dist

# SQL migration files (read at runtime by dist/migrate.js)
COPY migrations ./migrations

# Startup script
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

EXPOSE 3206

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3206/health || exit 1

# Run as non-root
USER node

# Migrations run first, then app starts (signals forwarded via exec)
CMD ["./entrypoint.sh"]
