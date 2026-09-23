# BACKEND_RECON — Phase 1 Repository Reconnaissance (Read-Only)

> Classification legend used in this report:
> - **Observation** — factual record from source inspection.
> - **Requires Phase 2 verification** — middleware/auth status must be confirmed during endpoint inventory; NOT a vulnerability verdict.
> - **Confirmed** — directly verified by reading the referenced file/line (applies to structure/config facts only, never to exploitability).

No code was modified during reconnaissance. No fixes, disables, or endpoint changes were made. No secret values are printed in this report.

---

## 1. Backend architecture

- **Observation (Confirmed):** Express 4.18 + TypeScript backend.
  - Evidence: `backend/package.json:31` (`express: ^4.18.2`), `backend/src/server.ts:4`, `backend/src/app.ts:1`.
- **Observation (Confirmed):** Entry point is `backend/src/server.ts`, which imports the Express app from `backend/src/app.ts`.
  - Evidence: `backend/src/server.ts:4` (`import app from './app'`), `backend/src/server.ts:61` (`app.listen(PORT, ...)`).
- **Observation (Confirmed):** `app.ts` builds the Express app (CORS, JSON body parser, router mounts, inline health/SMTP diagnostics endpoints).
  - Evidence: `backend/src/app.ts:15` (`const app = express()`), `backend/src/app.ts:25-44` (CORS), `backend/src/app.ts:44` (`express.json()`), `backend/src/app.ts:46-49` (router mounts), `backend/src/app.ts:52-63` (`/api/health`), `backend/src/app.ts:66-140` (`/api/smtp-debug`).
- **Observation (Confirmed):** `server.ts` additionally mounts system routes and wires failover + schedulers.
  - Evidence: `backend/src/server.ts:20` (`app.use('/api/system', systemRoutes)`), `backend/src/server.ts:24-59` (failover init), `backend/src/server.ts:66-71` (6 schedulers started).

## 2. Request flow

- **Observation (Confirmed):** `server.ts` → `app.ts` → module routers:
  - `/api/auth` → `modules/auth/auth.routes.ts` (Evidence: `app.ts:46`)
  - `/api/items` → `modules/inventory/inventory.routes.ts` (Evidence: `app.ts:47`)
  - `/api/borrow` → `modules/borrow/borrow.routes.ts` (Evidence: `app.ts:48`)
  - `/api` → `modules/dashboard/dashboard.routes.ts`, exposing `GET /api/stats` and `/api/audit*` (Evidence: `app.ts:49`, `dashboard.routes.ts:7-10`)
  - `/api/system` → `routes/system.routes.ts` (Evidence: `server.ts:20`, `system.routes.ts:13-26`)
  - Inline: `GET /api/health` (Evidence: `app.ts:52`), `GET /api/smtp-debug` (Evidence: `app.ts:66`)
- **Observation (Confirmed):** Global middleware order in `app.ts`: CORS → `express.json()` → routers. No session middleware instantiation, no helmet, no request-size limit option, no `trust proxy` setting observed in `app.ts`.
  - Evidence: `backend/src/app.ts:25-49`. (Absence noted as Observation; security impact is out of scope for Phase 1.)
- **Observation (Confirmed):** Rate-limit middleware exists as a module (`middleware/rateLimit.ts`: `generalLimiter`, `authLimiter`, `otpLimiter`, `adminLimiter`, `registerLimiter`) and is applied selectively on auth/admin routes.
  - Evidence: `backend/src/middleware/rateLimit.ts:14-76`, `backend/src/modules/auth/auth.routes.ts:27-48`.

## 3. Directory structure

- **Observation (Confirmed):** `backend/src` layout (via `glob src/**/*.ts`, 48 files):
  - `app.ts`, `server.ts`
  - `config/`: `database.ts`, `databaseRouter.ts`, `databaseTypes.ts`, `supabasePool.ts`, `neonPool.ts`, `neonApi.ts`, `redis.ts`, `healthMonitor.ts`, `dbHealth.ts`, `failover.ts`, `replication.ts`, `emailQueue.ts`, `idempotency.ts`
  - `middleware/`: `auth.middleware.ts`, `rateLimit.ts`
  - `modules/auth/`: `auth.routes.ts`, `auth.controller.ts`, `authOtpController.ts`, `authOtpService.ts`, `userApprovalService.ts`
  - `modules/inventory/`: `inventory.routes.ts`, `inventory.controller.ts`
  - `modules/borrow/`: `borrow.routes.ts`, `borrow.controller.ts`, `otpService.ts`, `hardwareRequestService.ts`, `adminDirectory.ts`
  - `modules/dashboard/`: `dashboard.routes.ts`, `dashboard.controller.ts`
  - `modules/system/`: `system.controller.ts` + `routes/system.routes.ts`
  - `services/`: `emailService.ts`, `reminderService.ts`, `reminderScheduler.ts`, `keepAliveService.ts`, `auditService.ts`, `auditCleanupService.ts`, `boteService.ts`
  - `validators/`: `auth.validator.ts`, `email.validator.ts`
  - `scripts/`: `seed-inventory.ts`, `reset-db.ts`, `provision-users.ts`, `provision-vardaan.ts`
  - `types/pg.d.ts`
- **Observation (Confirmed):** Tests live in `backend/test/` (11 files: api.integration, auth.middleware, bote, failover.integration, ha.shared, idempotency.unit, otp.unit, reminder, replication, system-health-check, verify-v1.5-stack).
- **Observation (Confirmed):** Schema/fixtures at `backend/supabase_schema.sql`, `backend/supabase_users_data.sql`, `backend/migrations/`, `backend/scripts/`.

## 4. Important security boundaries

- **Observation (Confirmed):** Enforcement is per-route via `authenticateToken` → optional `requireAdmin` / `requireRole(...)`.
  - Evidence: `middleware/auth.middleware.ts:51-103`; applied e.g. `auth.routes.ts:33-48`, `borrow.routes.ts:23-35`, `inventory.routes.ts:20-22`, `dashboard.routes.ts:8-10`, `system.routes.ts:20-24`.
- **Observation (Confirmed):** Some route definitions carry no `authenticateToken` in their definition line (list in §12). Whether they are intentionally public is **Requires Phase 2 verification**.
- **Observation (Confirmed):** Database trust boundary: backend uses Supabase `service_role` key server-side (bypasses RLS).
  - Evidence: `config/supabasePool.ts:40-43` (comment "bypasses RLS").
- **Observation (Confirmed):** Failover boundary: exactly-one-database-per-operation (no dual-write); secondary writes recorded to pending-change queue for reconciliation.
  - Evidence: `config/database.ts:252-272`, `databaseRouter.ts:1-12`.

## 5. Authentication architecture

- **Observation (Confirmed):** JWT-first Bearer with session-cookie fallback shape:
  1. `Authorization: Bearer <jwt>` verified with `jsonwebtoken` + optional `issuer`/`audience` when `JWT_ISSUER`/`JWT_AUDIENCE` are set.
  2. Else `req.session?.user` trusted if role is in `VALID_ROLES`.
  - Evidence: `middleware/auth.middleware.ts:1-86`.
- **Observation (Confirmed):** JWT issuance on login: payload `{id, name, email, role}`, `expiresIn: '7d'`, secret from `process.env.JWT_SECRET` with 500 misconfiguration guard.
  - Evidence: `modules/auth/auth.controller.ts:329-344`.
- **Observation (Confirmed):** JWT claim parsing restricts `role` to `ADMIN|MEMBER`; `id`+`email` must be strings; `roll_number` optional.
  - Evidence: `middleware/auth.middleware.ts:37-49` (`parseJwtUser`), `35` (`VALID_ROLES`).
- **Observation (Confirmed):** Session fallback references `req.session` / `express-session` store, and `clearSessionUser` destroys server-side session on logout.
  - Evidence: `middleware/auth.middleware.ts:78-83`, `107-114`.
- **Observation — Requires Phase 2 verification:** No `app.use(session(...))` / `connect-redis` store instantiation was observed in `app.ts`. Whether the session fallback path is live or dead code must be confirmed in Phase 2 by tracing app initialization and logout flow. NOT a vulnerability verdict.
- **Observation (Confirmed):** Registration → approval gate: `register` validates JIIT email domain, duplicate email/roll check, bcrypt hash (`genSalt(10)`), role derived from admin-email lists, initial status `APPROVED` with auto-approve path for college accounts; login enforces PENDING/REJECTED gates with DB re-sync.
  - Evidence: `auth.controller.ts:47-120` (register head), `auth.controller.ts:300-327` (approval gates), `auth.controller.ts:105-106` (bcrypt).
- **Observation (Confirmed):** Password recovery / OTP-login paths exist as route definitions: `/forgot-password`, `/reset-password`, `/change-password`, `/verify-login-otp`, `/resend-login-otp`, `/send-otp`, `/verify-otp`.
  - Evidence: `modules/auth/auth.routes.ts:29-40`.

## 6. Authorization / RBAC architecture

- **Observation (Confirmed):** Only two roles exist in middleware: `ADMIN | MEMBER`.
  - Evidence: `middleware/auth.middleware.ts:17-23` (`AuthUser`), `35` (`VALID_ROLES`), `88-103` (`requireAdmin`, `requireRole`).
- **Observation (Confirmed):** "Superadmin" exists only as email allow-lists, not as a role:
  - `MASTER_ADMIN_EMAIL` + `SUPER_ADMIN_EMAILS` (6 addresses) in `userApprovalService.ts:5-13`, mirrored in `emailService.ts:19-26`.
  - Name/email-substring admin matching (`vardaan`, `dhruvi`, `aryan`, `gunjan`, enrollment substrings) in `isDesignatedAdmin`.
  - Evidence: `modules/auth/userApprovalService.ts:15-37`.
  - Recorded as design observation; privilege implications are Phase 4 scope, not a Phase 1 verdict.
- **Observation (Confirmed):** Effective role on login elevates to `ADMIN` if master/designated, or stored `role`/`approval.role` is `ADMIN`.
  - Evidence: `auth.controller.ts:335-338`.
- **Observation (Confirmed):** Admin-only route groups observed: `auth.routes.ts:43-48` (`/admin/users*`), `borrow.routes.ts:26-27,34-35` (hardware approve/reject, ledger), `inventory.routes.ts:20-22` (create/update/delete), `dashboard.routes.ts:10` (`POST /audit/cleanup`), `system.routes.ts:20-24` (replication/failover ops).

## 7. Database architecture and failover

- **Observation (Confirmed):** Supabase PRIMARY for CRUD via PostgREST; Neon SECONDARY via `pg` Pool for complex/failover paths.
  - Evidence: `config/database.ts:1-10` (header), `config/databaseRouter.ts:18-39` (table sets), `server.ts:63` (log line describing mode).
- **Observation (Confirmed):** Table routing sets:
  - `SUPABASE_PRIMARY_TABLES` = `users, inventory, audit_logs, hardware_requests, borrow_records` (Evidence: `databaseRouter.ts:19-25`)
  - `SUPABASE_REPLICATED_TABLES` = `users, inventory, audit_logs, borrow_records` (Evidence: `databaseRouter.ts:28-33`)
  - `NEON_ATOMIC_TABLES` = currently empty set (Evidence: `databaseRouter.ts:38-39`)
- **Observation (Confirmed):** Health-aware failover: on Supabase network/service outage, flips to Neon; writes on secondary recorded to durable pending-change queue for later reconciliation; no dual-write.
  - Evidence: `config/database.ts:234-292` (`execute()`), `294-311` (`recordPendingChange`).
- **Observation (Confirmed):** Identifier/column escaping + parameterized Neon SQL (`escapeIdent`, `$1` params, `LIMIT` clamped 1–1000).
  - Evidence: `config/database.ts:68-70`, `610-659`, `471-475`.
- **Observation (Confirmed):** Join emulation map `FK_MAP` for PostgREST-style `inventory(...)` / `users(...)` selects on the Neon path.
  - Evidence: `config/database.ts:98-105`.
- **Observation (Confirmed):** Health/failover machinery: `healthMonitor.ts` (4-min interval, 3-failure threshold), `dbHealth.ts` (shared state), `failover.ts` state machine, `neonApi.ts` (promote/fence via Neon API), `replication.ts` (Supabase→Neon snapshot + reconcile + recovery).
  - Evidence: `config/healthMonitor.ts:25-40`, `server.ts:22-59`, `system.controller.ts:151-209`.

## 8. Redis / OTP / session architecture

- **Observation (Confirmed):** Redis client: real `ioredis` when `REDIS_URL` set (Upstash-compatible, `rediss://` TLS), else in-memory Map with identical async TTL interface; failures degrade to memory rather than crashing requests.
  - Evidence: `config/redis.ts:28-29`, `74-89`, `92-151`.
- **Observation (Confirmed):** Redis used for: OTP mirror, API response cache (`cacheGetJSON/SetJSON`, `cacheInvalidatePattern`), distributed locks (`acquireLock` SET NX PX, Lua compare-and-delete release; fails closed when Redis unavailable).
  - Evidence: `config/redis.ts:153-225`, `authOtpService.ts:30-56`, `borrow/otpService.ts:38-64`, `inventory.controller.ts:11-19`, `dashboard.controller.ts:8-17`.
- **Observation (Confirmed):** Two separate OTP systems:
  - Auth OTP: 5-min TTL, prefix `cicr:auth:otp:<sha256(otp)>`, 6-digit `crypto.randomInt`, in-memory Map + Redis mirror, 60s expiry sweeper. Evidence: `modules/auth/authOtpService.ts:18-64`.
  - Borrow OTP: 10-min TTL, prefix `cicr:otp:<sha256(otp)>`, same generation/storage pattern. Evidence: `modules/borrow/otpService.ts:26-71`.
  - OTP dispatch details (attempt limits, reuse/consumption paths) are Phase 3 scope.

## 9. External integrations

- **Observation (Confirmed):** Supabase (PostgREST + JS client, `SUPABASE_URL` / `ANON_KEY` / `SERVICE_ROLE_KEY`). Evidence: `config/supabasePool.ts:21-54`, `.env.example:8-10`.
- **Observation (Confirmed):** Neon PostgreSQL (primary/replica hosts, branch/project/API-key names; `pg` pools; Neon API promote/fence). Evidence: `.env.example:13-20`, `config/neonPool.ts`, `config/neonApi.ts`, `server.ts:23-35`.
- **Observation (Confirmed):** SMTP Gmail via Nodemailer (`SMTP_HOST/PORT/USER/PASS/FROM`), `secure` flag tied to port 465, IPv4-first DNS workaround. Evidence: `services/emailService.ts:100-112`, `config/emailQueue.ts:47-50`, `.env.example:46-50`.
- **Observation (Confirmed):** BullMQ email queue when Redis configured, else direct `sendMail` fallback. Evidence: `config/emailQueue.ts:1-7`, `23-50`.
- **Observation (Confirmed):** CORS allow-list: `localhost:5173`, `localhost:3000`, Vercel frontend, Render backend, plus `FRONTEND_URL`; non-production allows any origin; `credentials: true`.
  - Evidence: `app.ts:17-42`.
- **Observation (Confirmed):** No shell-exec, no dynamic `require()` of user input, no direct filesystem serving observed in reviewed paths; sole `fs` persistence observed is approval JSON store (see §10).

## 10. Background jobs / schedulers

- **Observation (Confirmed):** Six starters invoked in `server.ts:66-71`: reminder scheduler, health monitor, keep-alive, replication scheduler, DB-health sync, audit-retention scheduler.
- **Observation (Confirmed):** Due-date reminders via `node-cron` (`REMINDER_CRON` default `0 9 * * *`, plus interval/batch/lead-hour envs). Evidence: `services/reminderService.ts:5`, `.env.example:53-57`.
- **Observation (Confirmed):** Supabase keep-alive ping (read-only `SELECT`, default every 3 days, Redis-lock deduplicated). Evidence: `services/keepAliveService.ts:1-20`, `26-35`.
- **Observation (Confirmed):** Replication scheduler (default 5 min, `SYNC_INTERVAL_MS` / `REPLICATION_ENABLED`). Evidence: `.env.example:41-43`.
- **Observation (Confirmed):** Audit retention cleanup (`auditCleanupService.ts`, `RETENTION_DAYS`, triggered via scheduler + `POST /audit/cleanup`). Evidence: `dashboard.controller.ts:6`, `server.ts:71`.
- **Observation (Confirmed):** Graceful shutdown closes health/keepalive/replication/sync/cleanup + Neon pools with 10s forced-exit fallback. Evidence: `server.ts:93-110`.

## 11. Validation architecture

- **Observation (Confirmed):** Zod schemas in `validators/auth.validator.ts`: `loginSchema`, `registerSchema`, `verifyOtpSchema`, `resendOtpSchema`, `borrowRequestSchema`, `returnSchema`, `createItemSchema`, `updateItemSchema`; `validate()` middleware returns 400 with field errors and replaces `req.body` with parsed data.
  - Evidence: `validators/auth.validator.ts:8-165`.
- **Observation (Confirmed):** `validate()` applied on auth register/login/verify-OTP paths. Evidence: `auth.routes.ts:27-30`.
- **Observation — Requires Phase 2 verification:** Borrow/inventory/dashboard route files do not apply `validate()` in their route-definition lines; whether validation happens inside controllers must be traced per-endpoint in Phase 2/6. NOT a vulnerability verdict.

## 12. Security-sensitive files (non-exhaustive index)

| File | Why sensitive (Observation) |
|---|---|
| `backend/src/middleware/auth.middleware.ts` | JWT verify, role gate, session fallback — auth boundary |
| `backend/src/modules/auth/auth.controller.ts` | register/login/JWT issue, approval gates, password flows |
| `backend/src/modules/auth/authOtpController.ts`, `authOtpService.ts` | login OTP issue/verify, TTL store |
| `backend/src/modules/borrow/otpService.ts`, `borrow.controller.ts` | borrow OTP + stock/borrow/return logic |
| `backend/src/modules/auth/userApprovalService.ts` | admin allow-lists, approval state, JSON file persistence (`fs` read/write), DB sync |
| `backend/src/config/database.ts`, `databaseRouter.ts`, `supabasePool.ts`, `neonPool.ts` | DB routing, credentials use, RLS bypass (service_role), failover |
| `backend/src/config/redis.ts`, `emailQueue.ts` | session/cache/OTP/lock store, credential-bearing URL |
| `backend/src/services/emailService.ts` | SMTP transport, OTP/borrow emails, admin recipient lists |
| `backend/src/services/auditService.ts`, `auditCleanupService.ts` | audit trail writes/retention |
| `backend/src/app.ts`, `server.ts` | CORS, mounts, health/debug endpoints, scheduler wiring |
| `backend/src/routes/system.routes.ts`, `modules/system/system.controller.ts` | replication/failover ops, metrics endpoints |
| `backend/src/validators/auth.validator.ts`, `email.validator.ts` | input allow-lists |
| `backend/.env.example`, `.env.example` | env key inventory (placeholders only; no values) |
| `backend/supabase_schema.sql`, `supabase_users_data.sql`, `migrations/` | schema/seed data |
| `backend/src/scripts/*.ts` | seed/reset/provision (must verify no prod credentials) |
| `backend/test/*.cjs` | documents intended auth/OTP/failover behavior |

## 13. Endpoint observations requiring Phase 2 verification (NOT vulnerabilities)

Each item records: route-definition fact + evidence + required Phase 2 trace. No exploitability claim is made.

1. `GET /api/smtp-debug` — **Observation:** route defined in `app.ts:66` with no `authenticateToken` in the definition; handler returns `dns`, TCP probe results for `smtp.gmail.com:587/465`, and booleans `smtp_user_set`/`smtp_pass_set` (not values). **Requires Phase 2 verification:** confirm auth status, response shape, and whether it is debug-only. Do not fix/disable/protect/rename/delete during recon.
2. `GET /api/system/bote-metrics` — **Observation:** defined in `system.routes.ts:16` with no auth middleware in the definition; handler reads DB counts + cache. **Requires Phase 2 verification.**
3. `GET /api/system/simulate-scale` — **Observation:** defined in `system.routes.ts:17` with no auth middleware; parses numeric query params with finite/non-negative checks. **Requires Phase 2 verification.**
4. `GET /api/items`, `GET /api/items/categories`, `GET /api/items/:id` — **Observation:** defined in `inventory.routes.ts:15-17` with no `authenticateToken` in the definition. May be intentional public catalog reads. **Requires Phase 2 verification.**
5. `GET /api/stats` — **Observation:** defined in `dashboard.routes.ts:7` with no `authenticateToken`; returns aggregate counts + cached payload. **Requires Phase 2 verification.**
6. `GET /api/borrow/admins` — **Observation:** defined in `borrow.routes.ts:22` with no `authenticateToken`. **Requires Phase 2 verification** (directory sensitivity unknown until handler traced).
7. Session fallback liveness — **Observation:** `req.session` trusted in middleware but no session middleware instantiation observed in `app.ts`. **Requires Phase 2 verification** whether this path is reachable.
8. Validation placement — **Observation:** `validate()` absent from borrow/inventory/dashboard route-definition lines. **Requires Phase 2 verification** whether controllers validate internally.
9. Role namespace — **Observation:** middleware supports only `ADMIN|MEMBER`; "superadmin" appears only as email lists. **Requires Phase 2 verification** that no hidden superadmin routes/roles exist elsewhere.
10. `POST /api/auth/send-otp` — **Observation:** defined in `auth.routes.ts:31` with `otpLimiter` but no `validate(...)` wrapper (unlike neighboring OTP routes). **Requires Phase 2 verification** of handler-level validation.

---

## 14. Phase 1 close-out

- **Confirmed:** Reconnaissance completed read-only; no application code, config, routes, middleware, dependencies, or `.env` files modified.
- **Confirmed:** Pre-existing working-tree modifications (`backend/package-lock.json`, `package-lock.json`) left untouched.
- Next: Phase 2 Complete Endpoint Inventory — pending explicit approval. No endpoint analysis started.
