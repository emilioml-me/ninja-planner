# ninja-planner

Multi-tenant business planning SaaS — part of the Loki-IT ninja suite.

| Key | Value |
|-----|-------|
| Port | 3206 |
| Domain | ninja-planner.com (staging: ninja-planner.njn-stg.com) |
| Host | ninja-prod201 (10.10.1.10) |
| DB | PgBouncer pool `plan_ninja_db` at 10.10.1.60:25061, user `plan_ninja` (legacy `plan_ninja*` naming kept) |
| Node | 22 LTS (Dockerfile, CI and `engines`) |

---

## Local development

```bash
cp .env.example .env
# fill in DATABASE_URL, CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET

npm install
npm run migrate   # applies any pending migrations/*.sql
npm run dev
```

The dev server starts on port 3206 with hot-reload via `tsx watch`.

Checks (the same ones CI runs):

```bash
npm run typecheck    # server (tsconfig.json) + client (client/tsconfig.json)
npm test             # server tests
npm run test:client  # client tests
```

---

## Database setup (run once on ninja-db001)

SSH into ninja-db001 and create the user + database. The schema GRANT must run while connected to
the app database (`\c plan_ninja_db`), not the default `postgres` database:

```bash
ssh ubuntu@10.10.1.60
sudo -u postgres psql << 'EOF'
CREATE USER plan_ninja WITH PASSWORD '<strong-random-password>';
CREATE DATABASE plan_ninja_db OWNER plan_ninja;
\c plan_ninja_db
GRANT ALL ON SCHEMA public TO plan_ninja;
-- Optional: server-side statement timeout for the app role (PgBouncer rejects it as a
-- startup parameter, so it has to be set on the role).
ALTER ROLE plan_ninja SET statement_timeout = '30s';
EOF
```

Add the pool to PgBouncer (`/etc/pgbouncer/pgbouncer.ini`, `[databases]` section; the pool name
is what goes in `DATABASE_URL`):

```ini
plan_ninja_db = host=127.0.0.1 port=5432 dbname=plan_ninja_db
```

Add the user to `/etc/pgbouncer/userlist.txt` (`auth_type = scram-sha-256`; copy the SCRAM
secret from `SELECT rolpassword FROM pg_authid WHERE rolname = 'plan_ninja';`):

```
"plan_ninja" "SCRAM-SHA-256$..."
```

Reload PgBouncer (enough for a new pool/user; listen_addr/listen_port changes need a restart):

```bash
sudo systemctl reload pgbouncer
```

PgBouncer runs in transaction pool mode, so the app never relies on session state: migration
and scheduler locks are transaction-scoped (`pg_advisory_xact_lock`).

### Migrations

Do **not** apply `migrations/*.sql` by hand with `psql`. Migrations run automatically every time
the container starts (`entrypoint.sh` runs `node dist/scripts/migrate.js` before the app), and
locally via `npm run migrate`. The runner (`src/scripts/migrate.ts`):

- applies every `migrations/*.sql` not yet listed in `schema_migrations`, in filename order;
- runs each file plus its `schema_migrations` row in one transaction (a file's own
  `BEGIN;`/`COMMIT;` wrapper is stripped so it can't commit the outer transaction early);
- takes a transaction-scoped advisory lock (`pg_advisory_xact_lock`) at the start of each file's
  transaction and re-checks `schema_migrations` after acquiring it, so containers starting at the
  same time can't race each other (safe through PgBouncer transaction pooling);
- bounds waits with `MIGRATE_LOCK_WAIT_TIMEOUT` (default 120s, waiting for another runner),
  `MIGRATE_LOCK_TIMEOUT` (default 30s, per-DDL table lock wait) and `MIGRATE_STATEMENT_TIMEOUT`
  (default 15min).

Applying a file manually leaves it unrecorded, so the runner will try it again on the next start
and the container crash-loops on "already exists" errors. Never edit a migration that has already
been applied anywhere; add a new numbered file instead.

---

## Deploy

Production is deployed by pulling the repo on the server and rebuilding with docker compose (the
image is built on the host from source; the GHCR image CI pushes is not used by prod):

```bash
ssh ubuntu@10.10.1.10

# on ninja-prod201, in the repo clone:
cd /srv/apps/ninja-planner
sudo git pull --ff-only origin main
# VITE_CLERK_PUBLISHABLE_KEY is a build arg (baked into the bundle); compose refuses to build
# without it. Strip quotes so they don't end up in the bundle.
export VITE_CLERK_PUBLISHABLE_KEY=$(grep -E '^VITE_CLERK_PUBLISHABLE_KEY=' /srv/secrets/ninja-planner.env | tail -n 1 | cut -d= -f2- | tr -d "\"'\r")
sudo -E docker compose -f docker-compose.prod.saas.yml up -d --build
sudo docker compose -f docker-compose.prod.saas.yml ps
sudo docker compose -f docker-compose.prod.saas.yml logs --tail=100
```

Migrations run automatically on container start (see above). Migrations added by the
2026-10-20 fix pass, applied in this order:

1. `058_subscription_code_unique_v2.sql`
2. `059_goal_milestone_dedup_key.sql`
3. `060_sprint_commitment.sql`
4. `061_pending_uploads.sql`
5. `062_drop_redundant_indexes.sql`
6. `063_enum_check_constraints.sql`
7. `064_retention_indexes.sql`
8. `065_due_date_dispatch_confirm.sql`
9. `066_revenue_actual_source_manual.sql`
10. `067_crm_client_tombstones.sql`

The container gets `stop_grace_period: 30s`: on SIGTERM the app stops its schedulers, stops
accepting connections and drains in-flight background work (webhooks, emails) for up to 20s.

### First-time server setup

```bash
# Repo clone (deploys are `git pull` + `docker compose up -d --build` from here)
sudo mkdir -p /srv/apps
sudo git clone <repo-url> /srv/apps/ninja-planner

# Secrets file (path is fixed by env_file in docker-compose.prod.saas.yml;
# see .env.example for the full list of variables)
sudo mkdir -p /srv/secrets
sudo tee /srv/secrets/ninja-planner.env << 'EOF'
NODE_ENV=production
PORT=3206
DATABASE_URL=postgresql://plan_ninja:<password>@10.10.1.60:25061/plan_ninja_db?sslmode=disable
CLERK_SECRET_KEY=sk_live_...
CLERK_WEBHOOK_SECRET=whsec_...
ALLOWED_ORIGIN=https://ninja-planner.com
APP_URL=https://ninja-planner.com
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
EOF
sudo chmod 600 /srv/secrets/ninja-planner.env

# nginx site (from the repo clone)
sudo cp /srv/apps/ninja-planner/nginx/ninja-planner.com.conf /etc/nginx/sites-available/ninja-planner.com.conf
sudo ln -sf /etc/nginx/sites-available/ninja-planner.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

After any change to `nginx/ninja-planner.com.conf` (e.g. the www -> apex redirect and the
`X-Robots-Tag: noindex` header for `/g/`, `/r/`, `/invite/` and `/public/`), copy it again and run
`sudo nginx -t && sudo systemctl reload nginx`. `www.ninja-planner.com` always 301s to the apex:
Clerk only authorizes the apex origin, so the app does not work on www.

In the Clerk dashboard, the webhook endpoint (`https://ninja-planner.com/webhooks/clerk`) must
subscribe to `organization.created/updated/deleted`, `organizationMembership.created/updated/deleted`
and `user.updated` (new: keeps member display names/emails in sync).

The container publishes only `127.0.0.1:3207 -> 3206` (see `docker-compose.prod.saas.yml`), so it
is reachable only through the host's nginx (`upstream ... 127.0.0.1:3207`), never directly from
HAProxy or the network. `nginx -t` fails until the Let's Encrypt certificate referenced by the
443 block exists, so issue the certificate (next section) before enabling the site, or enable it
with only the port-80 server block first.

### SSL certificate (on ninja-prod201)

```bash
sudo certbot certonly --webroot -w /var/www/html -d ninja-planner.com -d www.ninja-planner.com
```

Cert-push to HAProxy2 (LXC 300) is handled automatically by the renewal hook at
`/etc/letsencrypt/renewal-hooks/post/cert-push.sh`.

For the initial push, run the hook manually:

```bash
sudo /etc/letsencrypt/renewal-hooks/post/cert-push.sh
```

### HAProxy2 backend (on LXC 300)

HAProxy routes to **nginx on ninja-prod201** (ports 80/443), which proxies to the container on
`127.0.0.1:3207`. Do not point HAProxy at port 3206/3207: the app port is bound to loopback only.
Add to `/etc/haproxy/haproxy.cfg` (same shape as the other ninja-prod backends):

```haproxy
acl host_ninja_planner hdr(host) -i ninja-planner.com www.ninja-planner.com
use_backend ninja_planner_http  if host_ninja_planner   # http_in
use_backend ninja_planner_https if host_ninja_planner   # https_in

backend ninja_planner_http
    balance roundrobin
    option httpchk GET /
    server ninja-prod201 10.10.1.10:80 check

backend ninja_planner_https
    balance roundrobin
    timeout tunnel 1h
    server ninja-prod201 10.10.1.10:443 ssl verify none
```

(This is already live on ninja-haproxy002; it is here for reference. HAProxy keeps sending www to
nginx, which does the www -> apex redirect.)

Reload HAProxy:

```bash
sudo systemctl reload haproxy
```

### Staging (ninja-planner.njn-stg.com)

`docker-compose.stg.yml` runs with `network_mode: host`, `PORT=3208` and `HOST=127.0.0.1`, so the
app binds loopback only and is reachable just through the host nginx
(`nginx/ninja-planner.njn-stg.com.conf`, upstream `127.0.0.1:3208`). A directly reachable 3208
would bypass nginx and let clients spoof `X-Forwarded-For` (rate limits, audit logs), so keep the
firewall rule as a second layer:

```bash
sudo ufw deny 3208/tcp
```

The staging nginx conf sends HSTS, `X-Robots-Tag: noindex, nofollow` on every response and serves
its own `robots.txt` (`Disallow: /`); after changing it, copy it to `/etc/nginx/sites-available/`
and `sudo nginx -t && sudo systemctl reload nginx`.

Deploy with `scripts/deploy-stg.sh` on the staging host. It refuses to run unless the clone is on
`main`, fast-forward pulls, rebuilds, and fails non-zero if `/health` doesn't come up within 60s.
CI's `deploy-staging` job runs the same script, but only on a self-hosted runner registered on the
staging host with the labels `self-hosted, ninja-stg` (GitHub-hosted runners cannot reach the
private network); until such a runner exists the job stays queued.

---

## API overview

Full spec: `openapi.yaml`, served at `/api/docs/`.

Most `/api/*` routes require a Clerk Bearer token; the workspace is derived from the active
organization (`org_id` claim) in the JWT. `/api/external/*` uses a workspace API key instead.
These routes need **no** token (they are rate limited per client IP):

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health + DB check (`{status, app, version, db}`, 503 when the DB is down) |
| POST | /webhooks/clerk | Clerk org/membership/user sync (svix-signed) |
| POST | /api/integrations/crm/webhook | crm-ninja events (HMAC-signed) |
| POST | /api/integrations/ninja-task/webhook | ninja-task events (HMAC-signed) |
| GET | /public/roadmap/:token | Public roadmap share link |
| POST/DELETE | /public/roadmap/:token/votes/:itemId | Public roadmap votes |
| GET | /public/g/:token | Guest view (project share link) |
| GET | /api/invites/token/:token | Invite lookup (accepting needs a session) |
| GET | /api/docs/ | API docs (Swagger UI) |

Selected session routes:

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/workspaces/me | Active workspace + the caller's `my_role` |
| GET | /api/workspaces/me/members | List members |
| PATCH | /api/workspaces/:id | Update name (admin) |
| GET | /api/tasks | List tasks (filters: status, priority, assignee, tag, due_before, due_after; limit/offset) |
| POST | /api/tasks | Create task |
| GET | /api/tasks/:id | Task + activity log |
| PATCH | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Soft delete (admin) |
| PATCH | /api/tasks/:taskId/time-logs/:id | Edit a time log (`hourly_rate` admin only) |
| GET | /api/webhooks/events | Subscribable webhook events |
| POST | /api/webhooks/:id/rotate-secret | New signing secret (admin) |
| GET | /api/integrations/capabilities | Which integration actions are available |
| GET | /api/revenue | List revenue targets |
| POST | /api/revenue | Create target |
| PATCH | /api/revenue/:id | Update amounts/notes |
| DELETE | /api/revenue/:id | Delete target |
| GET | /api/clients | List clients (filter: stage) |
| POST | /api/clients | Create client |
| PATCH | /api/clients/:id | Update client |
| DELETE | /api/clients/:id | Delete client |
| GET | /api/roadmap | List roadmap items (filter: status, phase) |
| POST | /api/roadmap | Create item |
| PATCH | /api/roadmap/:id | Update item |
| DELETE | /api/roadmap/:id | Delete item |
| GET | /api/reviews | List weekly reviews (limit/offset, `X-Total-Count`) |
| POST | /api/reviews | Create review |
| GET | /api/reviews/:id | Single review |
| PATCH | /api/reviews/:id | Update review |
