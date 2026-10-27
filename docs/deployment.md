# Deployment & Operations Guide (`docs/deployment.md`)

## 1. Topology
Run the three runtime components as separate services sharing PostgreSQL, Redis, and private object storage:
1. **`@commhub/api`** — stateless NestJS HTTP API behind a TLS reverse proxy (Nginx / ALB / Cloudflare).
2. **`@commhub/worker`** — separate Node.js process running BullMQ workers, the transactional outbox publisher, and the stale-submission reconciler.
3. **`@commhub/web`** — static Vite production bundle (`apps/web/dist`) served by the reverse proxy, proxying `/api/*` to `@commhub/api`.

## 2. Production Environment Variables
Provide secrets via your platform's secret manager (AWS Secrets Manager, Vault, Kubernetes Secrets, etc.) — never commit `.env` files:
- `NODE_ENV=production`
- `DATABASE_URL=postgresql://...` (with `?sslmode=require`)
- `REDIS_URL=rediss://...` (configured with `noeviction` and AOF persistence)
- `JWT_ACCESS_SECRET` & `JWT_REFRESH_SECRET` (≥32 random bytes each)
- `WEBHOOK_SIGNING_SECRET` (provider webhook HMAC secret)
- `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (optional for S3-compatible stores) + standard AWS IAM credentials
- `PROVIDER_MODE=MOCK` (keep as `MOCK` until a verified production adapter, written provider approval, credentials, and compliance checklist are all complete)

## 3. Database Migrations & Backups
- Apply migrations during deployment before starting new API/worker instances:
  ```bash
  npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
  ```
- **Backups**: enable automated daily PostgreSQL snapshots + point-in-time recovery (WAL archiving). Test restoration quarterly into an isolated staging database and verify `AuditLog`, `Suppression`, and `CampaignRecipient` integrity.
- **Retention**: purge expired `Session` rows and archive `ImportBatch` raw CSV files from object storage according to the organisation's approved retention policy while retaining `Suppression` and `AuditLog` records.
