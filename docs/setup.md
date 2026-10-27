# Local Setup & Troubleshooting (`docs/setup.md`)

## Prerequisites
- **Node.js** 20+ (verified on Node v24.14.0) and **npm** 10+
- **PostgreSQL 16** on `localhost:5432`
- **Redis 7** (or **Memurai Developer** on Windows) on `localhost:6379`

You can run PostgreSQL and Redis either via Docker (`npm run infra:up`, using `infra/docker-compose.yml`) or as native Windows services.

## 1. Environment Configuration
Copy `.env.example` to `.env` and `apps/api/.env`. Placeholder values work out of the box in `MOCK` mode — **no external telecom credentials are required to start or test the application locally**.

## 2. Install & Build
```powershell
npm install
npm run build
```

## 3. Database Migration & Demo Seed
```powershell
cd apps/api
npx prisma migrate deploy
npm run seed
```
The seed creates clearly-labelled demo data (`DEMO_SEED`) and four staff accounts (password `Demo-Password-2026!`):
- `admin@demo.local` (`ADMIN`)
- `operator@demo.local` (`OPERATOR`)
- `approver@demo.local` (`APPROVER`)
- `auditor@demo.local` (`AUDITOR`)

## 4. Running the Platform (Three Processes)
```powershell
# Terminal 1 — NestJS API (http://localhost:3000, Swagger at http://localhost:3000/api/docs)
npm run start -w @commhub/api

# Terminal 2 — Separate BullMQ Worker Process
npm run start -w @commhub/worker

# Terminal 3 — React + Vite Web Dashboard (http://localhost:5173)
npm run dev -w @commhub/web
```

## 5. Running Automated Tests
```powershell
npm test
```
Tests run against the isolated `commhub_test` database in `MOCK` mode and never send real communications.

## Troubleshooting
- **`EPERM: operation not permitted, rename ... query_engine-windows.dll.node`**: Stop the running API/worker process before running `npx prisma generate` or `prisma migrate`.
- **Port 5432 / 6379 refused**: Verify `postgresql-x64-16` and `Memurai` Windows services are running (`Get-Service *postgres*,*memurai*`).
- **429 Too Many Requests on `/api/auth/login`**: Login rate limiting is 5 requests/minute per IP by default (`LOGIN_RATE_LIMIT`).
