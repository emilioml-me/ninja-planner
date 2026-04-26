# ninja-planner

Multi-tenant business planning SaaS — part of the Loki-IT ninja suite.

| Key | Value |
|-----|-------|
| Port | 3206 |
| Domain | plan-ninja.com |
| Host | ninja-prod201 (10.10.1.10) |
| DB | plan_ninja_db via PgBouncer (plan_ninja_pool) at 10.10.1.60:25061 |

---

## Local development

```bash
cp .env.example .env
# fill in DATABASE_URL, CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET

npm install
npm run dev
```

The dev server starts on port 3206 with hot-reload via `tsx watch`.

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

Run the migration from your local machine (or any host with psql access):

```bash
psql "postgresql://plan_ninjausr:<password>@10.10.1.60:25061/plan_ninja_pool?sslmode=disable" \
  -f migrations/001_init.sql
```

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
scp ninja-planner-$TAG.tar.gz ubuntu@10.10.1.10:/srv/apps/plan-ninja/
ssh ubuntu@10.10.1.10

# on the server:
cd /srv/apps/plan-ninja
docker load < ninja-planner-$TAG.tar.gz
sed -i "s|ninja-planner:.*|ninja-planner:$TAG|" docker-compose.prod.saas.yml
sudo docker compose -f docker-compose.prod.saas.yml up -d
docker compose -f docker-compose.prod.saas.yml ps
```

### First-time server setup

```bash
# App directory
sudo mkdir -p /srv/apps/plan-ninja
sudo chown ubuntu:ubuntu /srv/apps/plan-ninja

# Secrets file
sudo mkdir -p /srv/secrets
sudo tee /srv/secrets/plan-ninja.env << 'EOF'
NODE_ENV=production
PORT=3206
DATABASE_URL=postgresql://plan_ninjausr:<password>@10.10.1.60:25061/plan_ninja_pool?sslmode=disable
CLERK_SECRET_KEY=sk_live_...
CLERK_WEBHOOK_SECRET=whsec_...
ALLOWED_ORIGIN=https://plan-ninja.com
EOF
sudo chmod 600 /srv/secrets/plan-ninja.env

# Copy compose + nginx config
scp docker-compose.prod.saas.yml ubuntu@10.10.1.10:/srv/apps/plan-ninja/
scp nginx.conf ubuntu@10.10.1.10:/etc/nginx/sites-available/plan-ninja.conf
ssh ubuntu@10.10.1.10 "sudo ln -sf /etc/nginx/sites-available/plan-ninja.conf /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx"
```

### SSL certificate (on ninja-prod201)

```bash
sudo certbot certonly --nginx -d plan-ninja.com
```

Cert-push to HAProxy2 (LXC 300) is handled automatically by the renewal hook at
`/etc/letsencrypt/renewal-hooks/post/cert-push.sh`.

For the initial push, run the hook manually:

```bash
sudo /etc/letsencrypt/renewal-hooks/post/cert-push.sh
```

### HAProxy2 backend (on LXC 300)

Add to `/etc/haproxy/haproxy.cfg`:

```haproxy
acl host_plan_ninja hdr(host) -i plan-ninja.com
use_backend be_plan_ninja if host_plan_ninja

backend be_plan_ninja
    option httpchk GET /health
    server ninja-prod201 10.10.1.10:3206 check
```

Reload HAProxy:

```bash
sudo systemctl reload haproxy
```

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
