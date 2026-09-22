# ninja-planner

Multi-tenant business planning SaaS — part of the Loki-IT ninja suite.

| Key | Value |
|-----|-------|
| Port | 3206 |
| Domain | ninja-planner.com (staging: ninja-planner.njn-stg.com) |
| Host | ninja-prod201 (10.10.1.10) |
| DB | via PgBouncer at 10.10.1.60:25061 (database/user names keep the legacy `plan_ninja*` naming) |

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

SSH into ninja-db001 and create the user + database:

```bash
ssh ubuntu@10.10.1.60
sudo -u postgres psql << 'EOF'
CREATE USER plan_ninjausr WITH PASSWORD '<strong-random-password>';
CREATE DATABASE plan_ninja_db OWNER plan_ninjausr;
GRANT ALL ON SCHEMA public TO plan_ninjausr;
EOF
```

Add to PgBouncer (`/etc/pgbouncer/pgbouncer.ini`):

```ini
plan_ninja_pool = host=127.0.0.1 port=5432 dbname=plan_ninja_db user=plan_ninjausr
```

Add to userlist (`/etc/pgbouncer/userlist.txt`):

```
"plan_ninjausr" "<plain-password>"
```

Reload PgBouncer:

```bash
sudo systemctl reload pgbouncer
```

### Migrations

Do **not** apply `migrations/*.sql` by hand with `psql`. Migrations run automatically every time
the container starts (`entrypoint.sh` runs `node dist/scripts/migrate.js` before the app), and
locally via `npm run migrate`. The runner (`src/scripts/migrate.ts`):

- applies every `migrations/*.sql` not yet listed in `schema_migrations`, in filename order;
- runs each file plus its `schema_migrations` row in one transaction (a file's own
  `BEGIN;`/`COMMIT;` wrapper is stripped so it can't commit the outer transaction early);
- holds a Postgres advisory lock for the whole run, so containers starting at the same time
  can't race each other.

Applying a file manually leaves it unrecorded, so the runner will try it again on the next start
and the container crash-loops on "already exists" errors. Never edit a migration that has already
been applied anywhere; add a new numbered file instead.

---

## Deploy

Build and tag the Docker image:

```bash
TAG=1.0.0
docker build -t ninja-planner:$TAG .
docker save ninja-planner:$TAG | gzip > ninja-planner-$TAG.tar.gz
```

Ship to production (ninja-prod201):

```bash
scp ninja-planner-$TAG.tar.gz ubuntu@10.10.1.10:/srv/apps/ninja-planner/
ssh ubuntu@10.10.1.10

# on the server:
cd /srv/apps/ninja-planner
docker load < ninja-planner-$TAG.tar.gz
sed -i "s|ninja-planner:.*|ninja-planner:$TAG|" docker-compose.prod.saas.yml
sudo docker compose -f docker-compose.prod.saas.yml up -d
docker compose -f docker-compose.prod.saas.yml ps
```

### First-time server setup

```bash
# App directory
sudo mkdir -p /srv/apps/ninja-planner
sudo chown ubuntu:ubuntu /srv/apps/ninja-planner

# Secrets file (path is fixed by env_file in docker-compose.prod.saas.yml;
# see .env.example for the full list of variables)
sudo mkdir -p /srv/secrets
sudo tee /srv/secrets/ninja-planner.env << 'EOF'
NODE_ENV=production
PORT=3206
DATABASE_URL=postgresql://plan_ninjausr:<password>@10.10.1.60:25061/plan_ninja_pool?sslmode=disable
CLERK_SECRET_KEY=sk_live_...
CLERK_WEBHOOK_SECRET=whsec_...
ALLOWED_ORIGIN=https://ninja-planner.com
EOF
sudo chmod 600 /srv/secrets/ninja-planner.env

# Copy compose + nginx config
scp docker-compose.prod.saas.yml ubuntu@10.10.1.10:/srv/apps/ninja-planner/
scp nginx/ninja-planner.com.conf ubuntu@10.10.1.10:/etc/nginx/sites-available/ninja-planner.com.conf
ssh ubuntu@10.10.1.10 "sudo ln -sf /etc/nginx/sites-available/ninja-planner.com.conf /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx"
```

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
    server ninja-prod201 10.10.1.10:443 ssl verify none
```

Reload HAProxy:

```bash
sudo systemctl reload haproxy
```

### Staging (ninja-planner.njn-stg.com)

`docker-compose.stg.yml` runs with `network_mode: host` and `PORT=3208`, so the app listens on
**all host interfaces on port 3208** (inside the container it has to bind 0.0.0.0). The host
firewall on the staging VM must block 3208 from everything except loopback; only the host nginx
(`nginx/ninja-planner.njn-stg.com.conf`, upstream `127.0.0.1:3208`) should reach it. Because the
app trusts `X-Forwarded-*` headers from its proxy, a directly reachable 3208 would let clients spoof
their IP (rate limits, audit logs). Example with ufw:

```bash
sudo ufw deny 3208/tcp
```

Deploy with `scripts/deploy-stg.sh` on the staging host (pulls, rebuilds, and fails non-zero if
`/health` doesn't come up within 60s).

---

## API overview

All routes except `/health` and `/webhooks/clerk` require a Clerk Bearer token.
Workspace context is derived automatically from the `org_id` claim in the JWT.

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /webhooks/clerk | Clerk org/membership sync |
| GET | /api/workspaces/me | Workspaces the caller belongs to |
| GET | /api/workspaces/:id | Single workspace |
| PATCH | /api/workspaces/:id | Update name/plan |
| GET | /api/workspaces/:id/members | List members |
| DELETE | /api/workspaces/:id/members/:memberId | Remove member |
| GET | /api/tasks | List tasks (filters: status, priority, assignee, tag, due_before, due_after) |
| POST | /api/tasks | Create task |
| GET | /api/tasks/:id | Task + activity log |
| PATCH | /api/tasks/:id | Update task |
| PATCH | /api/tasks/:id/position | Update kanban position |
| DELETE | /api/tasks/:id | Soft delete |
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
| GET | /api/reviews | List weekly reviews |
| POST | /api/reviews | Create review |
| GET | /api/reviews/:id | Single review |
| PATCH | /api/reviews/:id | Update review |
