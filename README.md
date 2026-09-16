<div align="center">

<img src="./logo.png" width="90" alt="CICR Logo" />

# CICR Inventory Hub

**Creative & Innovative Cell in Robotics — Inventory & Hardware Allocation System**

Track, reserve, and deploy microcontrollers, sensors, and actuators from JIIT's robotics vault with a modern full-stack web platform: **React-free Vite + Three.js & Canvas VFX engines**, **Node.js/Express REST API**, **Supabase (PostgreSQL)** persistence, **Redis** session caching & queues, and **Nodemailer** transactional telemetry.

[![Live Demo](https://img.shields.io/badge/LIVE-cicrinventory.vercel.app-00f0ff?style=for-the-badge&logo=vercel&logoColor=white)](https://cicrinventory.vercel.app/)
[![Repo](https://img.shields.io/badge/GITHUB-CICR__Inventory-bd00ff?style=for-the-badge&logo=github&logoColor=white)](https://github.com/simplyvardaan/CICR_Inventory)
[![Backend](https://img.shields.io/badge/API-Render%20Web%20Service-46e3b7?style=for-the-badge&logo=render&logoColor=white)](https://cicr-inventory-backend.onrender.com)
[![License](https://img.shields.io/badge/LICENSE-MIT-1e2327?style=for-the-badge)](#-license)

</div>

---

## 📑 Table of Contents

- [Version History](#-version-history)
- [System Architecture](#-system-architecture)
- [Tech Stack](#-tech-stack)
- [Repository Structure](#-repository-structure)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [Dual Superadmin & Institutional Auth Guard](#-dual-superadmin--institutional-auth-guard)
- [Admin Portal & Multi-Tier Hardware Queue](#-admin-portal--multi-tier-hardware-queue)
- [Frontend Themes & Interactive Canvas Engines](#-frontend-themes--interactive-canvas-engines)
- [API Reference](#-api-reference)
- [Email Telemetry & Notification Workflow](#-email-telemetry--notification-workflow)
- [Back-of-the-Envelope (BOTE) Estimation & Scalability](#-back-of-the-envelope-bote-estimation--scalability)
- ["Crack vs Smooth Surface" — System Analysis](#-crack-vs-smooth-surface--system-analysis)
- [Third-Party Integration Bottlenecks & Rate Limits](#-third-party-integration-bottlenecks--rate-limits)
- [Database Schema](#-database-schema)
- [Testing](#-testing)
- [Production Deployment](#-production-deployment)
- [Mentors & Core Team](#-mentors--core-team)
- [Known Issues & Roadmap](#-known-issues--roadmap)
- [License](#-license)

---

## 📌 Version History

| Version | Status | Key Milestones & Changes |
|---------|--------|---------------------------|
| **v1.0.0** | ✅ Released | Initial frontend (Vite + Three.js) and Express server baseline. |
| **v1.1.0** | ✅ Released | Supabase PostgreSQL schema, JWT authentication, core inventory routes. |
| **v1.2.1** | ✅ Released | Frontend-backend integration, borrow/return logic, and route fixes. |
| **v1.3.2** | ✅ Released | Nodemailer transport, SMTP config, and base transactional email dispatch. |
| **v1.4.3** | ⚠️ Pre-release | Admin OTP approval (`request-otp` / `verify-otp`), 1–30 day rental cap, Day N-1 return reminders. |
| **v1.4.4** | ✅ Released | Custom Message-ID, X-headers, plain-text fallback, and SMTP response logging. |
| **v1.4.5** | ⚠️ Pre-release | Frontend dynamic `API_BASE` points to local backend on port 5000. End-to-end OTP borrow flow verified. |
| **v1.4.6** | ⚠️ Pre-release | Sender pinned to verified Gmail, `test-email.cjs` probe, `002_seed_test_users.sql`. |
| **v1.4.7** | ⚠️ Pre-release | RFC 2822 dynamic Message-ID, `validators/email.validator.ts` for 12-digit `@mail.jiit.ac.in` IDs. |
| **v1.5.0** | ✅ Released | Redis sessions, `dbRead`/`dbWrite` split, BullMQ email queue, RBAC middleware, API response cache (30s TTL). |
| **v1.6.0** | ✅ Released | Frontend UI merge (dark theme, Three.js backgrounds, sidebar, modals). CORS updated to `CLIENT_URL`. |
| **v1.6.1** | ✅ Released | Purged hardcoded mock credentials, added PostgreSQL database reset scripts. |
| **v1.6.2** | ✅ Released | OTP-based login (`send-otp` / `verify-otp`), institutional domain enforcement. |
| **v1.6.4** | ✅ Released | Inventory CRUD + borrow flow wired end-to-end via authenticated API calls. |
| **v1.7.0** | ✅ Released | **Backend hardening.** Server refuses to start without `JWT_SECRET`. Atomic SQL concurrency guards on `available_quantity` prevent double-borrowing. Added `000_create_tables.sql` base migration. |
| **v2.0.0** | ✅ Released | **Institutional Auth & Dual Superadmin.** Strictly enforced `@mail.jiit.ac.in` institutional email format for students; registered accounts enter `PENDING` status awaiting admin verification; master superadmins locked to `vardaansaxena096@gmail.com` and `cicrinventory@gmail.com`. |
| **v2.2.0** | ✅ Released | **Admin Portal & Queues.** Compact cyberpunk redesign for Admin Control Center; added Member Approval queue and Hardware Issue Requests queue with multi-tier sync across Supabase, REST API, and local storage fallback. |
| **v2.3.0** | ✅ Released | **Cyber Telemetry Redesign.** Transactional emails updated to authentic cyber aesthetic (zero emojis); automated instant alerts for member signups, approvals, rejections, hardware requests, and dual superadmin instant CC notifications. |
| **v2.4.0** | ✅ Released | **Frontend Architecture & Roster.** Auto-detecting dynamic `API_BASE` (localhost vs. Render production); CORS configured for Vercel; added **Meet The Developers** team showcase, collapsible Vault Index sidebar navigation, out-of-stock indicators, and color-coded transaction logs. |
| **v2.5.0** | ✅ Released | **CanvasFX Visual Engines.** Added 60 FPS physics-based **Sakura (Cherry Blossom)** falling petals engine and cinematic **Avengers Assemble** theme featuring vibrating Captain America Vibranium shield with radial gradients, Arc Reactor HUD, and ambient energy sparks. |
| **v2.5.1** | ✅ Released | **Production Deployment & Security Hardening.** Dual-endpoint hardware request fallback, theme contrast optimizations, verified SMTP fallback for Render production (`render.yaml`), Vercel SPA build config (`vercel.json`), and purge of compiled build artifacts from source control. |
| **v2.6.0** | ✅ Released | **10-Min OTP Verification Popup, 10-Min Cooldown Gap, 5-Field Registration & Real-Time Audit Stream.** Security verification popup modal for sign-in requiring 6-digit email OTP (strictly valid for 10 minutes with enforced 10-minute gap before new OTP generation), 5-field registration (`Name`, `Email`, `Username`, `Enrollment Number`, `Batch`), flexible sign-in via Email/Username/Name, real-time System Audit & Activity Logs stream (`#admin-audit-section`), in-app item deletion, 6-second auto-sync engine, zero mock data. |
| **v2.7.0** | ✅ Released | **Master Whitelist Enforcement, Theme Background Hardening & Complete Database Purge.** All test/pending data cleared across Supabase PostgreSQL tables (`borrow_records`, hardware issue requests, `audit_logs`, `inventory`, and non-admin user accounts); database strictly holds dual master superadmins (`vardaansaxena096@gmail.com` and `cicrinventory@gmail.com`); theme backgrounds hardened with `!important` rule overrides and dynamic client-side cloud API failover. |
| **v2.8.0** | ✅ Released | **Zero-Latency 1-Click Approvals, Request De-duplication Engine, Tamper-Proof Autofilled Borrower Lock, Complete 54-Item Catalog & Cold-Start Session Recovery.** Instant optimistic UI card removal for hardware and member authorizations; atomic submit lock with composite content-based request de-duplication; automated read-only prefill for student borrower credentials; comprehensive 54-component robotics inventory with 500-unit limit; updated developer roster with crisp SVG links; and backend memory caching (15s TTL) with cold-start resilient auth recovery. |
| **v2.8.1** | ✅ Released | **Mobile & Desktop Responsive Overhaul, Touch Interaction Optimization & Notification Telemetry Fix.** Comprehensive responsive overhaul across mobile and desktop; single-column catalog grid on mobile ($\le 640\text{px}$) with natural multi-line titles, smooth horizontal swipeable category pills, balanced 2x2 stats grid, responsive dashboard greeting & digital clock cockpit, 300ms tap latency removal via `touch-action: manipulation`, tactile active tap feedback, and real-time notification telemetry counter sync. |
| **v2.9.0** | ✅ Released | **Hardware Return Dispatch with Dynamic Partial/Full Stepper, Admin Verification Portal, Roster Polish & Testing Email Routing.** Re-added Return Issued Component flow allowing borrowers to return issued hardware with customizable return quantities (`[-]` / `[+]` steppers and `Return All` shortcut); return requests dispatch to the Admin Portal for physical verification before inventory stock is restored; active loan badges with 1-click return triggers on inventory cards; updated developer showcase layout with integrated navigation sidebar; updated mentor guidance credits; and test email routing proxy redirecting all transactional activity emails to `vardaansaxena096@gmail.com` with branded test dispatch headers. |
| **v2.9.1** | ✅ Released | **Production Clean Transactional Email Headers.** Removed the debug `[CICR TEST DISPATCH]` banner header across direct and queue-dispatched transactional emails, providing clean, authentic, and modern cyber templates across all user notifications. |
| **v2.10.0** | ✅ Released | **7-Day Centralized Audit & Telemetry Log System.** Centralized backend log persistence with automated 7-day retention pruning scheduler (runs at boot + every 6 hours), real-time 7-day activity spectrum HUD with interactive day filtering, category counters (Auth, Inventory, Hardware, Loans, System), CSV export, manual retention sync trigger, live detail inspection modal, and client log dispatch pipeline. |

> The current active release is **v2.10.0 — 7-Day Centralized Audit & Telemetry Log System**. Both the Vercel frontend and Render backend run in production with live database sync, multi-tier hardware queues, 7-day centralized audit persistence, and automated transactional telemetry.

### 🏷️ Version Registry (Git Tags)

| Version | Git Tag | Status | Focus Area |
|---------|---------|--------|------------|
| **v1.0.0** | `v1.0.0` | ✅ Released | Initial MVP |
| **v1.5.0** | `v1.5.0` | ✅ Released | Redis Caching & Queue |
| **v1.7.0** | `v1.7.0` | ✅ Released | Backend Hardening & Atomic Guards |
| **v2.0.0** | `v2.0.0` | ✅ Released | Dual Superadmin & Institutional Auth |
| **v2.2.0** | `v2.2.0` | ✅ Released | Admin Portal & Hardware Issue Queues |
| **v2.3.0** | `v2.3.0` | ✅ Released | Cyber-Themed Transactional Telemetry |
| **v2.4.0** | `v2.4.0` | ✅ Released | Developer Roster & Collapsible Navigation |
| **v2.5.0** | `v2.5.0` | ✅ Released | Avengers & Sakura Canvas Engines |
| **v2.5.1** | `v2.5.1` | ✅ Released | Production Deployments & Security Polish |
| **v2.6.0** | `v2.6.0`, `v2.6` | ✅ Released | 10-Min OTP Popup, 10-Min Cooldown Gap, 5-Field Registration & Audit Stream |
| **v2.7.0** | `v2.7.0` | ✅ Released | Database Purge, Master Admin Whitelist & Theme Engine Hardening |
| **v2.8.0** | `v2.8.0`, `v2.8` | ✅ Released | 1-Click Approvals, Request De-duplication, Locked Borrower Details & 54-Item Catalog |
| **v2.8.1** | `v2.8.1`, `v2.8` | ✅ Released | Mobile & Desktop Responsive Overhaul, Touch Interaction & Telemetry Sync |
| **v2.9.0** | `v2.9.0`, `v2.9` | ✅ Released | Hardware Return Dispatch, Partial Stepper, Admin Verification & Test Mail Routing |
| **v2.9.1** | `v2.9.1` | ✅ Released | Production Clean Transactional Email Headers |
| **v2.10.0** | `v2.10.0`, `v2.10` | ✅ Released | 7-Day Centralized Audit Ledger, Telemetry HUD & Backend Auto-Retention |

---

## 🏗️ System Architecture

```
┌────────────────────────────────────────────────────────┐
│                        CLIENT                          │
│   Vite 8 + Vanilla TypeScript + Three.js + Canvas 2D   │
│   • Cyber Dark / Sakura Blossom / Avengers Themes      │
│   • Meet The Developers / Collapsible Vault Index      │
│   • Dynamic API Base Auto-Resolution                   │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS / JSON (REST API)
                            ▼
┌────────────────────────────────────────────────────────┐
│                      BACKEND API                       │
│           Node.js ≥ 18 + Express 4 + TypeScript        │
│   • Auth & RBAC Middleware (Dual Superadmin Guards)    │
│   • Inventory CRUD & Atomic Concurrency Guards         │
│   • Hardware Issue Request Pipeline                    │
│   • BOTE Metrics & Capacity Simulation Engine          │
└─────────────┬────────────────────────────┬─────────────┘
              │                            │
   ┌──────────▼───────────┐     ┌──────────▼───────────┐
   │        REDIS         │     │  SUPABASE POSTGRES   │
   │  • Session Store     │     │  • dbRead (Replica)  │
   │  • API Cache (30s)   │     │  • dbWrite (Primary) │
   │  • BullMQ Queue      │     │  • users / inventory │
   │  • OTP State Store   │     │  • borrow_records    │
   └──────────────────────┘     └──────────┬───────────┘
                                           │ Multi-tier Sync
                                ┌──────────▼───────────┐
                                │   LOCAL PERSISTENCE  │
                                │  • hardware_requests │
                                │  • user_approval     │
                                └──────────┬───────────┘
                                           │ Transactional Alerts
                                           ▼
                                ┌──────────────────────┐
                                │   GMAIL SMTP RELAY   │
                                │ cicrinventory@gmail  │
                                │ • Student Alerts     │
                                │ • Superadmin CCs     │
                                └──────────────────────┘
```

### Request Lifecycle (Hardware Issue Flow)

1. **Student Request**: Student logs in with institutional credentials (`<enrollment>@mail.jiit.ac.in`) and submits a hardware issue request (`POST /api/borrow/request`).
2. **Instant Alert**: Backend saves the request to the pending queue with multi-tier sync (Supabase + local storage fallback) and dispatches an instant cyber notification email to the Dual Superadmins (`vardaansaxena096@gmail.com` and `cicrinventory@gmail.com`).
3. **Admin Review**: Admin opens the **Admin Portal** (`GET /api/borrow/requests`), inspects purpose, requested duration, and current inventory stock.
4. **Approval & Stock Decrement**: Admin clicks Approve (`POST /api/borrow/requests/:id/approve`):
   - Database atomically decrements `available_quantity` (`gte` stock check prevents over-allocation).
   - A `borrow_records` row is created with calculated `due_date` (`requested_at + duration_days`).
   - Request status shifts to `APPROVED`.
5. **Telemetry Dispatch**: Fire-and-forget confirmation email is dispatched to the student with borrow details, return deadline, and component care instructions, alongside an admin audit confirmation.
6. **Automated Reminders**: `reminderService` (daily cron + startup scan) tracks loan status and alerts borrowers on Day N-1 (due tomorrow), Day Due, and overdue intervals.

---

## 🛠️ Tech Stack

| Layer | Technology | Details |
|-------|------------|---------|
| **Frontend** | Vite 8, TypeScript 5, Three.js, Lucide Icons | Vanilla DOM architecture, responsive cyber glassmorphism, zero framework bloat. |
| **VFX & Animation** | HTML5 Canvas 2D + WebGL | 60 FPS Sakura falling petal simulation & Avengers Arc Reactor / Vibranium shield HUD. |
| **Backend** | Node.js ≥ 18, Express 4, TypeScript 5 | Modular route architecture (`auth`, `inventory`, `borrow`, `dashboard`, `system`). |
| **Database** | Supabase (PostgreSQL) | PostgREST connection with `dbRead` (replica/primary) and `dbWrite` (primary) separation. |
| **Multi-Tier Sync** | JSON State Layer | Fallback storage for offline/resilient recovery (`hardware_requests_data.json`, `user_approval_data.json`). |
| **Cache & Queues** | Redis via `ioredis` + `connect-redis` | Session persistence, 30-second inventory response cache, BullMQ async worker queues. |
| **Authentication** | JWT (`jsonwebtoken`) + `bcryptjs` | 7-day token lifespan, institutional `@mail.jiit.ac.in` domain enforcement, admin approval gate. |
| **Email Telemetry** | Nodemailer | Authenticated Gmail SMTP relay (`cicrinventory@gmail.com`) with cyber-styled HTML & text fallbacks. |
| **Scheduler** | `node-cron` | Automated loan audits, due-tomorrow reminders, and overdue sweeps. |
| **Testing** | Node built-in test runner (`node --test`) | Unit tests for auth/middleware, BOTE estimation, and end-to-end integration tests. |
| **Deployment** | Vercel (Frontend) · Render (Backend) | Single-page application rewrites via `vercel.json`; containerized Node service via `render.yaml`. |

---

## 📁 Repository Structure

```
CICR_Inventory/
├── backend/                             # Express + TypeScript REST API
│   ├── src/
│   │   ├── server.ts                    # HTTP server entry + reminder scheduler
│   │   ├── app.ts                       # Express app, middleware, routes, and Supabase client
│   │   ├── config/
│   │   │   ├── database.ts              # dbRead (replica) & dbWrite (primary) clients
│   │   │   ├── redis.ts                 # Redis connection + in-memory cache fallback
│   │   │   └── emailQueue.ts            # BullMQ email queue producer & worker
│   │   ├── modules/
│   │   │   ├── auth/                    # Register, login, OTP login, user approvals, profile
│   │   │   │   ├── auth.controller.ts
│   │   │   │   ├── auth.routes.ts
│   │   │   │   ├── authOtpController.ts
│   │   │   │   ├── authOtpService.ts
│   │   │   │   └── userApprovalService.ts # Student registration approval state
│   │   │   ├── borrow/                  # Direct borrow, hardware request queue, returns, history
│   │   │   │   ├── adminDirectory.ts    # Authorized administrators directory
│   │   │   │   ├── borrow.controller.ts
│   │   │   │   ├── borrow.routes.ts
│   │   │   │   ├── hardwareRequestService.ts # Multi-tier hardware request queue
│   │   │   │   └── otpService.ts
│   │   │   ├── inventory/               # Catalog CRUD, categories, stock tracking
│   │   │   │   ├── inventory.controller.ts
│   │   │   │   └── inventory.routes.ts
│   │   │   ├── dashboard/               # Stats and audit logs
│   │   │   └── system/                  # BOTE capacity metrics & load simulation
│   │   ├── middleware/
│   │   │   └── auth.middleware.ts       # JWT verification, RBAC guards (`requireAdmin`)
│   │   ├── validators/
│   │   │   └── email.validator.ts       # Institutional 12-digit student domain validator
│   │   └── services/
│   │       ├── emailService.ts          # Cyber-styled transactional email templates & SMTP transport
│   │       ├── reminderService.ts       # Cron-based due/overdue reminder sweeps
│   │       ├── reminderScheduler.ts
│   │       └── boteService.ts           # Back-of-the-envelope capacity calculator
│   ├── migrations/
│   │   ├── 000_create_tables.sql        # Core DDL (users, inventory, borrow_records, audit_logs)
│   │   ├── 001_add_due_date_to_borrow_records.sql
│   │   └── 002_seed_test_users.sql
│   ├── test/                            # Auth, BOTE, and API integration test suites
│   ├── .env.example                     # Environment template
│   ├── package.json
│   ├── render.yaml                      # Render deployment specification
│   └── tsconfig.json
├── src/                                 # Vite + Three.js Frontend
│   ├── main.ts                          # UI controller, dynamic API routing, canvas VFX loops
│   ├── types.ts                         # TypeScript domain models
│   ├── style.css                        # Glassmorphism cyber UI, responsive grid, theme variables
│   └── assets/                          # Static assets and icons
├── public/                              # Static public files & developer photos
│   ├── devs/                            # Team & mentor portraits
│   └── logo.png                         # CICR emblem
├── docs/                                # Architectural guides and calculations
│   ├── BACKEND_HANDOFF.md
│   └── BOTE_ESTIMATION.md               # Email throughput and scalability derivation
├── index.html                           # Root HTML, navigation, modals, and canvas layers
├── package.json
├── render.yaml                          # Root Render blueprint
├── vercel.json                          # Vercel SPA build and rewrite rules
├── tsconfig.json
└── README.md                            # System documentation
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: `≥ 18.0.0` (tested on Node v20 & v24)
- **npm**: `≥ 9.0.0`
- **Supabase Account**: A PostgreSQL project with PostgREST enabled.
- **Gmail Account**: With 2-Factor Authentication enabled and a 16-character **App Password** generated.
- **Redis** *(Optional)*: Local Redis instance or cloud provider (e.g. Upstash). In-memory fallback activates automatically if omitted.

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/simplyvardaan/CICR_Inventory.git
cd CICR_Inventory

# Install Frontend dependencies
npm install

# Install Backend dependencies
cd backend
npm install
cd ..
```

### 2. Configure Backend Environment

Copy the template file inside `backend/`:

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with your project secrets (see [Environment Variables](#-environment-variables)).

### 3. Initialize Database Schema

Open the Supabase SQL Editor and execute:
1. `backend/migrations/000_create_tables.sql` (Creates `users`, `inventory`, `borrow_records`, `audit_logs`, and indexes).
2. `backend/migrations/001_add_due_date_to_borrow_records.sql` (Adds `due_date` tracking).

### 4. Start the Application

#### Start the Backend API (Port 5000)

```bash
cd backend
npm run dev        # nodemon + ts-node watch mode
# or for production:
npm run build && npm start
```

#### Start the Frontend Client (Port 5173)

```bash
# In the repository root
npm run dev
```

Visit `http://localhost:5173` in your browser.

> **Dynamic API Resolution**: The frontend detects local development automatically (`localhost` / `127.0.0.1`) and targets `http://localhost:5000/api`. On production deployments, it targets `https://cicr-inventory-backend.onrender.com/api` unless overridden by `VITE_API_BASE`.

---

## 🔑 Environment Variables

All backend configuration is managed through environment variables in `backend/.env`:

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `PORT` | No | `5000` | Local HTTP port for the Express REST API. |
| `NODE_ENV` | No | `development` | Environment mode (`development` / `production`). |
| `SUPABASE_URL` | **Yes** | — | Supabase project API URL (e.g. `https://xyz.supabase.co`). |
| `SUPABASE_ANON_KEY` | **Yes** | — | Supabase public anonymous key (RLS-protected). |
| `SUPABASE_READ_URL` | No | — | Dedicated read replica URL for `dbRead`. Falls back to `SUPABASE_URL`. |
| `JWT_SECRET` | **Yes** | — | Cryptographic secret for signing and verifying JWT tokens. Server halts if missing. |
| `JWT_ISSUER` | No | `cicr-inventory` | Optional JWT issuer claim verification. |
| `JWT_AUDIENCE` | No | `cicr-members` | Optional JWT audience claim verification. |
| `REDIS_URL` | No | — | Redis connection string (e.g. `redis://127.0.0.1:6379`). Defaults to in-memory fallback. |
| `SESSION_SECRET` | No | `cicr_session_secret` | Session cookie signing key. |
| `SMTP_HOST` | No | `smtp.gmail.com` | SMTP host for outbound transactional emails. |
| `SMTP_PORT` | No | `587` | SMTP port (STARTTLS standard 587). |
| `SMTP_USER` | **Yes** | `cicrinventory@gmail.com` | Authenticating sender Gmail address. Mock mode activates if left blank. |
| `SMTP_PASS` | **Yes** | — | 16-character Google App Password (requires 2FA). |
| `SMTP_FROM` | No | `"CICR Inventory" <cicrinventory@gmail.com>` | Formatted RFC 5322 From header. |
| `SMTP_REPLY_TO` | No | `"CICR Inventory (No-Reply)" <noreply.cicrinventory@gmail.com>` | Reply-To header. |
| `REMINDER_CRON` | No | `0 9 * * *` | Cron schedule for loan sweeps (default: daily at 09:00 AM). |
| `VITE_API_BASE` | No | *Auto-detected* | Frontend environment variable to override backend API endpoint. |

---

## 🛡️ Dual Superadmin & Institutional Auth Guard

To safeguard club hardware and maintain strict audit accountability, the system enforces a strict two-tier security model:

```
                  ┌────────────────────────────────────────┐
                  │          REGISTRATION ATTEMPT          │
                  └───────────────────┬────────────────────┘
                                      │
                         Is Authorized Superadmin?
                                ├── YES ──► Status: APPROVED · Role: ADMIN
                                │           Instant Full Access
                                │
                                └── NO ───► Must Match Institutional Domain
                                            (^[0-9]{12}@mail\.jiit\.ac\.in$)
                                                ├── NO  ──► 400 REJECTED (External Email Blocked)
                                                └── YES ──► Status: PENDING · Role: MEMBER
                                                            Blocked from Login until Approved
```

### 1. Dual Master Superadmins
Administrative privileges and Admin Portal access are restricted to two authorized master identities:
- **`vardaansaxena096@gmail.com`** (Main Master Admin)
- **`cicrinventory@gmail.com`** (CICR System Admin & Telemetry Relay)

Any login or registration from these identities is automatically granted `APPROVED` status with full `ADMIN` role persistence across restarts.

### 2. Institutional 5-Field Student Registration
Student registration enforces collection and validation of 5 required credentials:
1. **Full Name** (`name`): Student's real identity (e.g., `Vardaan Saxena`).
2. **College Email** (`email`): Official JIIT institutional email matching `^[a-zA-Z0-9._%+-]+@mail\.jiit\.ac\.in$` *(e.g., `992501030399@mail.jiit.ac.in`)*.
3. **Username** (`username`): Unique alphanumeric handle for login and system tagging *(e.g., `vardaan_09`)*.
4. **Enrollment Number** (`roll_number`): 12-digit university roll number *(e.g., `992501030399`)*.
5. **Batch** (`batch`): Academic graduation cohort *(e.g., `2022-2026` or `2024`)*.
6. **Password** (`password`): Strong hashed passphrase (bcrypt 10 rounds).

### 3. Flexible Multi-Identifier Sign-In
Users and administrators can authenticate via multiple identity vectors:
- **Sign In Using**: `Email` OR `Username` OR `Full Name` + `Password`.
- The authentication controller dynamically resolves the identifier across Supabase PostgreSQL records, username metadata lookups, and administrator aliases (`vardaan`, `vardaansaxena`, `cicradmin`, `CICR Admin`).

### 4. User-Only 5-Minute Login Security Notice
Upon every successful sign-in:
- The system autogenerates a time-sensitive security transmission featuring a unique 6-digit session authorization code.
- **Validity Window**: Strictly valid for **5 minutes only**.
- **Privacy & Isolation**: Dispatched **strictly to the logging-in user's email only**. No administrators receive this login alert.

### 5. Student Registration Approval Gate & Admin Alert
- When an eligible student submits registration, their account enters **`PENDING`** status.
- An immediate cyber telemetry alert is dispatched to both Superadmins displaying all 5 applicant credentials (`Name`, `Email`, `Username`, `Enrollment`, `Batch`).
- The student cannot log in until an administrator reviews and approves the account in the **Admin Portal**.
- Upon approval, the student receives an automated **Account Approved** welcome email detailing access guidelines.

---

## 📊 Admin Portal & Multi-Tier Hardware Queue

The **Admin Portal** (`#admin-view`) is accessible only to authenticated administrators. It provides a cyberpunk command center for managing requests and members:

### 1. Hardware Issue Requests Queue
Instead of direct checkouts, students submit hardware requests with details on project purpose and required duration. Admins can:
- **Inspect**: Review the student's name, enrollment number, requested component, required quantity, and project justification.
- **Approve**: Atomically decrements warehouse inventory, creates an active loan record, computes the return deadline, and triggers confirmation emails to the borrower and CCs superadmins.
- **Reject**: Rejects the request with an optional note and notifies the student via email.

### 2. Member Approvals Queue
- Real-time queue displaying newly registered students awaiting verification.
- One-click **Approve** (activates student access) or **Reject** (revokes registration).
- Role management allowing administrators to promote approved members to `ADMIN` or demote to `MEMBER`.

### 3. Multi-Tier Resilience Sync
Hardware requests and user approval states utilize a multi-tier persistence pipeline:
1. **Supabase PostgreSQL**: Primary cloud database.
2. **Express In-Memory Cache**: Zero-latency lookups and instant state reflection.
3. **Local JSON Backing** (`hardware_requests_data.json` & `user_approval_data.json`): Protects against cloud network interrupts, guaranteeing that pending requests and member reviews survive server restarts.

### 4. Direct In-App Item Deletion & Cascading Clean
- Authorized administrators can permanently delete items directly from vault item cards (`.btn-card-delete-item`) or the Component Detail Modal (`#btn-modal-delete-item`).
- **Cyber Confirmation Shield**: Prompts a confirmation modal (`#delete-confirm-modal`) with component telemetry before deletion.
- **Relational Integrity**: Automatically cascades and deletes historical borrow records linked to the item in PostgreSQL before deleting the inventory row, preventing foreign-key constraints.
- **Emergency Superadmin Telemetry**: Dispatches an instant high-priority red-badge email notification to all master superadmins (`vardaansaxena096@gmail.com` and `cicrinventory@gmail.com`) documenting the deleted item name, category, quantity, location, timestamp, and deleting admin credentials.

### 5. System Audit & Activity Logs Command Center
- Live telemetry center (`#admin-audit-section`) integrated into the Admin Portal stream tracking all operations across the platform:
  - **`AUTH`**: New student registrations, admin account approvals, rejections, role modifications, user deletions, and user sign-ins.
  - **`INVENTORY`**: Component catalog additions, stock quantity adjustments, and deletions.
  - **`HARDWARE`**: Student hardware issue requests, administrative approvals, and rejections.
  - **`LOANS`**: Component checkout events, OTP approvals, and inventory returns.
- Interactive category filter tabs (`ALL`, `AUTH`, `INVENTORY`, `HARDWARE`, `LOANS`) and instant substring search filter.
- Distinct color-coded badge indicators (Green for creation, Red for deletion/rejection, Cyan for auth/sign-in, Yellow for modification).

### 6. Real-Time 6-Second Auto-Sync Engine
- Client-side background daemon (`DatabaseManager.startAutoSync(6000)`) polls the Express API and Supabase every 6 seconds:
  - Auto-refreshes warehouse inventory stock counts and availability.
  - For active administrators: polls pending hardware requests, user approvals queue, and live audit log stream.
  - Guarantees immediate cross-browser reactivity across all devices without manual page reloads.

---

## 🎨 Frontend Themes & Interactive Canvas Engines

The client features dynamic visual engines rendered via HTML5 Canvas 2D and Three.js:

```
                               ┌── Cyber Dark (Default) ── Neon cyan accents & glassmorphic cards
                               │
Theme Switcher (src/main.ts) ──┼── Sakura (Cherry Blossom) ── 60 FPS falling & swaying petal engine
                               │
                               └── Avengers Assemble ────── Cinematic Vibranium Shield + Arc Reactor HUD
```

### 1. Avengers Assemble Theme
- **Captain America Vibranium Shield**: Rendered on a full-screen canvas with metallic concentric rings, deep blue central medallion, crisp radial gradients, and animated ambient red aura.
- **Arc Reactor HUD**: Pulsing cyan energy core with rotating technical reticles, angle brackets, and telemetry grids.
- **Energy Sparks**: Ambient ascending sparks with randomized velocity and alpha blending.

### 2. Cherry Blossom (Sakura) Theme
- **Physics-Based Petal Engine**: Simulates 75 independent floral petals falling at 60 frames per second.
- **Complex Dynamics**: Features sinusoidal horizontal sway, 3D flip angle simulation via cosine scaling, randomized rotational drift, and soft dual-gradient coloring (`#ffd1e8` to `#ec4899`).

### 3. Meet The Developers & Mentors
An interactive section celebrating the engineering minds behind the CICR Robotics Vault:
- **Under The Guidance of**: Mentor Gunjan Pal (*Management Head, CICR*).
- **Meet The Developers**: Core engineering team members Vardaan Saxena, Kushagra Garg, Mahak Katahara, and Divyam Jain with custom glowing profile frames and role badges.

### 4. Collapsible Vault Index
- Left-sidebar collapsible drawer organizing hardware by categories: **Controllers**, **Sensors**, **Actuators**, **Power**, and **Tools**.
- Real-time out-of-stock badges and color-coded transaction logs.

---

## 📡 API Reference

Base URL (Local): `http://localhost:5000` · Base URL (Production): `https://cicr-inventory-backend.onrender.com`

Auth Scheme: `Authorization: Bearer <JWT>`

### System & Health

| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| `GET` | `/api/health` | Public | System health check → `{ status: "ok" }`. |
| `GET` | `/api/system/bote-metrics` | Public | Live Back-of-the-Envelope capacity snapshot (daily quota usage, peak burst, latency). |
| `GET` | `/api/system/simulate-scale` | Public | Projects email and DB load under custom user counts (`?users=5000&borrowsPerUser=2`). |

### Authentication & User Management

| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| `POST` | `/api/auth/register` | Public | Register new account (JIIT domain required; defaults to `PENDING` status). |
| `POST` | `/api/auth/login` | Public | Authenticate user → Returns JWT token & profile. Blocked if status is `PENDING`. |
| `POST` | `/api/auth/send-otp` | Public | Dispatch OTP for passwordless login. |
| `POST` | `/api/auth/verify-otp` | Public | Verify login OTP and issue JWT session. |
| `GET` | `/api/auth/profile` | Bearer | Fetch profile of currently authenticated user. |
| `GET` | `/api/auth/admin/users` | Admin | List all registered members with pending/approved status. |
| `POST` | `/api/auth/admin/users/:id/approve` | Admin | Approve pending student registration; sends welcome email. |
| `POST` | `/api/auth/admin/users/:id/reject` | Admin | Reject student registration. |
| `POST` | `/api/auth/admin/users/:id/role` | Admin | Update user role (`ADMIN` or `MEMBER`). |
| `DELETE` | `/api/auth/admin/users/:id` | Admin | Delete a user account. |

### Inventory Management

| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| `GET` | `/api/items` | Public | List all items with live availability. Supports `?category=` & `?search=`. |
| `GET` | `/api/items/categories` | Public | Fetch available inventory categories. |
| `GET` | `/api/items/:id` | Public | Fetch specific item details. |
| `POST` | `/api/items` | Admin | Create component. Sends notification to superadmins. |
| `PATCH` | `/api/items/:id` | Admin | Update item metadata or total quantity (recalcs availability). |
| `DELETE` | `/api/items/:id` | Admin | Delete item from vault catalog. |

### Hardware Requests & Borrowing

| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| `POST` | `/api/borrow/request` | Bearer | Student submits hardware issue request `{ itemId, quantity, purpose, durationDays }`. |
| `GET` | `/api/borrow/requests` | Bearer | List hardware issue requests. Students see own requests; Admins see all. |
| `POST` | `/api/borrow/requests/:id/approve` | Admin | Approve request: decrements inventory, creates loan, sends email receipt. |
| `POST` | `/api/borrow/requests/:id/reject` | Admin | Reject request with optional review notes. |
| `POST` | `/api/borrow` | Bearer | Direct checkout (legacy/admin). Atomically decrements stock and schedules reminders. |
| `POST` | `/api/borrow/return` | Bearer | Return component: increments available stock and dispatches return receipt. |
| `GET` | `/api/borrow/history` | Bearer | Fetch borrow records. Filtered by user for students; global for admins. |
| `GET` | `/api/borrow/admins` | Bearer | Fetch list of active system administrators. |

### Dashboard & Telemetry

| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| `GET` | `/api/stats` | Public | Aggregate counts: items, users, active loans, total vs. available quantities. |
| `GET` | `/api/audit` | Bearer | Fetch latest 50 security and operational audit log entries. |

---

## ✉️ Email Telemetry & Notification Workflow

Transactional emails are handled in `backend/src/services/emailService.ts`. All templates follow a **cyber aesthetic** (dark slate backgrounds, cyan accents, monospace metadata blocks, and zero emojis).

```
                      ┌────────────────────────────────────────┐
                      │            NODEMAILER RELAY            │
                      │    Sender: cicrinventory@gmail.com     │
                      └───────────────────┬────────────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                 ▼
┌──────────────────┐            ┌──────────────────┐            ┌──────────────────┐
│  STUDENT ALERTS  │            │  SUPERADMIN CCs  │            │ CRON REMINDERS   │
│ • Registration   │            │ • New Signup     │            │ • Day N-1 Notice │
│ • Approval/Reject│            │ • Issue Request  │            │ • Day Due Alert  │
│ • Loan Receipt   │            │ • Item Created   │            │ • Overdue Notice │
│ • Return Receipt │            │ • Loan Checkout  │            └──────────────────┘
└──────────────────┘            └──────────────────┘
```

### Automated Triggers & Email Notification Matrix

#### 👨‍💼 Admin Notification Matrix
Administrators strictly receive automated notifications for all operational laboratory events:
1. **Due Date Reminders (Other Borrowers & Own Issued Components)**: Automated sweeps scan for loans due tomorrow (`sendUpcomingReminder`) and items due today or overdue (`sendReturnReminder` / `sendDueReminder`). Notifications are dispatched to both the borrower and all superadmins, ensuring complete visibility over other students' and admins' own borrowed equipment.
2. **New Account Registration Requests**: Instant cyber notification dispatched to all superadmins whenever a new student registers, containing full applicant telemetry: **Full Name**, **College Email**, **Username**, **Enrollment Number**, and **Batch**.
3. **Component Issue Requests + Return Notifications**:
   - **Issue Request**: Sent to superadmins whenever a student requests hardware from the catalog, detailing request ID, component, requested quantity, purpose, and estimated return date.
   - **Checkout Confirmation**: Telemetry receipt dispatched upon admin approval.
   - **Return Notification**: Immediate return notification sent to superadmins confirming that hardware has been returned and restocked in the vault.
4. **Admin Inventory Add / Remove Component Alerts**:
   - **Item Added**: When any admin vaults a new component, all superadmins receive an instant notification with initial stock, category, location, and registration details.
   - **Item Deleted**: When any admin deletes an item, a high-priority telemetry alert is sent to all superadmins documenting the purged item name, quantity, category, and deleting admin credentials.

#### 👤 User-Only Sign-In Notice
- **Login Security Transmission**: Upon successful sign-in, an autogenerated email is dispatched **strictly to the account holder**.
- **No administrators receive this transmission** (isolated for user privacy).
- **5-Minute Expiration**: The session authorization code and sign-in notice are explicitly valid for **5 minutes only**.

---

## 🧮 Back-of-the-Envelope (BOTE) Estimation & Scalability

A detailed derivation is available in [`docs/BOTE_ESTIMATION.md`](./docs/BOTE_ESTIMATION.md). Key throughput limits for club operations:

### Gmail Free Tier Quota
- Gmail SMTP free tier allows up to **500 outbound emails/day/account**.
- A standard hardware lifecycle consumes ~3 emails (request/approval + borrow receipt + return receipt).
- **Daily Ceiling**:
  $$\text{Max Workflows/Day} = \frac{500}{3} \approx 166 \text{ complete borrow workflows/day}$$
- Sufficient for collegiate robotics club operations (~10–30 daily interactions).

### Concurrency & Performance
- **Web API Tier**: Express 4 + Supabase PostgREST connection pooling supports **500–1,000 concurrent active users** with $p95 < 1\text{s}$.
- **Memory Footprint**: Redis queue job size is ~2 KB. Tracking 10,000 reminder jobs requires only **~20 MB** of queue memory.
- **Enterprise Escape Hatch**: For campus-wide scaling (>10,000 students), transition `emailService.ts` from Nodemailer/Gmail to **AWS SES** or **Resend** ($0.10 per 1,000 emails).

---

## ⚖️ "Crack vs Smooth Surface" — System Analysis

### 🟩 The Smooth Surface (Scales Effortlessly)
- **Database & Read Replica**: Supabase PostgreSQL effortlessly handles catalog search, item metadata, and historical records.
- **Stateless REST Layer**: Express API instances can be scaled horizontally behind Render's load balancers.
- **Fast In-Memory Lookups**: Multi-tier cache layer resolves frequent catalog requests with sub-millisecond response times.

### 🟥 The Crack (Bottlenecks to Monitor)
- **Gmail 500/day SMTP Quota**: The single hard ceiling. High burst volumes during club recruiting drives could saturate the daily quota.
- **Institutional Spam Filtering**: `.ac.in` gateways occasionally sinkhole external HTML-only mail. Solved via plain-text fallbacks, explicit RFC 2822 Message-IDs, and sender reputation alignment.

---

## ⛓️ Third-Party Integration Bottlenecks & Rate Limits

| Service | Tier Limit | Consequence when Exceeded | Architectural Mitigation |
|---------|:----------:|---------------------------|--------------------------|
| **Gmail SMTP** | 500 emails/day | `550 Quota exceeded` | BullMQ Redis queue rate-limiting; migration to AWS SES / Resend. |
| **Gmail Burst** | ~25–30 emails/min | `421 Temporary rate limit` | BullMQ async retry worker with exponential backoff. |
| **Supabase Free** | 60 direct connections | Connection exhaustion | Node connection pool capped at 40; transaction pooler on port 6543. |
| **Supabase DB** | 500 MB storage | Read-only mode | Regular vacuuming and archival of old audit logs. |

---

## 🗄️ Database Schema

### Entity-Relationship Overview

```
users ─────────────────────────────┐
  id UUID PK                       │ (Logical Link)       borrow_records
  name TEXT                        │                     ├─ id UUID PK
  email TEXT UNIQUE                │                     ├─ inventory_id UUID FK ──► inventory
  password_hash TEXT               │                     ├─ borrower_name TEXT        id UUID PK
  roll_number TEXT                 ├────────────────────►├─ roll_number TEXT          name TEXT
  role TEXT (ADMIN|MEMBER)         │                     ├─ purpose TEXT              category TEXT
  created_at TIMESTAMPTZ           │                     ├─ quantity INT              quantity INT
                                   │                     ├─ borrowed_at TIMESTAMPTZ  available_quantity INT
audit_logs                         │                     ├─ returned_at TIMESTAMPTZ  location TEXT
  id UUID PK                       ├──── user_id (FK)    ├─ status TEXT (BORROWED...) status TEXT
  action TEXT                      │                     └─ due_date TIMESTAMPTZ     created_at TIMESTAMPTZ
  item_id UUID (FK) ► inventory ───┘
  description TEXT
  timestamp TIMESTAMPTZ
```

### Core PostgreSQL DDL

```sql
-- ============ users ============
CREATE TABLE IF NOT EXISTS public.users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  roll_number   TEXT,
  role          TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('ADMIN', 'MEMBER')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ inventory ============
CREATE TABLE IF NOT EXISTS public.inventory (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  description        TEXT,
  category           TEXT,
  quantity           INT  NOT NULL DEFAULT 0,
  available_quantity INT  NOT NULL DEFAULT 0,
  location           TEXT,
  tags               JSONB DEFAULT '[]'::jsonb,
  image              TEXT,
  status             TEXT DEFAULT 'AVAILABLE',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ borrow_records ============
CREATE TABLE IF NOT EXISTS public.borrow_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID,
  inventory_id  UUID REFERENCES public.inventory (id),
  borrower_name TEXT,
  roll_number   TEXT,
  purpose       TEXT,
  quantity      INT  NOT NULL DEFAULT 1,
  borrowed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at   TIMESTAMPTZ,
  due_date      TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'BORROWED' CHECK (status IN ('BORROWED', 'RETURNED'))
);

-- ============ audit_logs ============
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action      TEXT,
  user_id     UUID REFERENCES public.users (id),
  item_id     UUID REFERENCES public.inventory (id),
  description TEXT,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_borrow_inventory ON public.borrow_records (inventory_id);
CREATE INDEX IF NOT EXISTS idx_borrow_user      ON public.borrow_records (user_id);
CREATE INDEX IF NOT EXISTS idx_borrow_status    ON public.borrow_records (status);
CREATE INDEX IF NOT EXISTS idx_borrow_due_date  ON public.borrow_records (due_date);
```

---

## 🧪 Testing

Run backend unit and integration suites using Node's native test runner:

```bash
cd backend
npm test          # Runs all test suites (*.test.cjs)
```

- **`test/auth.middleware.test.cjs`**: Validates JWT token verification, expiration handling, and RBAC admin route guards.
- **`test/api.integration.test.cjs`**: End-to-end integration tests hitting auth endpoints, catalog CRUD, request-to-borrow conversions, and stock consistency.
- **`test/bote.test.cjs`**: Verifies Back-of-the-Envelope mathematical models and capacity estimation logic.
- **`test/system-health-check.cjs`**: Diagnostic verification script validating database connectivity, admin directory configuration, and live SMTP transport.

---

## 🚢 Production Deployment

The platform is structured for independent zero-downtime deployment:

### 1. Frontend → Vercel

The frontend is configured via [`vercel.json`](./vercel.json):
- Framework: `vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- API Proxy Rewrites: Seamlessly proxies `/api/(.*)` to `https://cicr-inventory-backend.onrender.com/api/$1` to avoid cross-origin overhead.
- Single Page Application rewrites route all incoming requests to `/index.html`.

Deploy using the Vercel CLI or Git integration:
```bash
npm run build
vercel --prod
```

### 2. Backend → Render

The backend is configured via [`render.yaml`](./render.yaml):
- Service Type: `web`
- Environment: `node`
- Root Directory: `backend`
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Auto-starts the Express REST API and spins up the cron reminder scheduler on startup.

Configure environment variables in the Render Dashboard matching `backend/.env.example`.

---

## 👥 Mentors & Core Team

### Under The Guidance of
- **Gunjan Pal** — Management Head, CICR

### Core Engineering Team
- **Vardaan Saxena** — Full-Stack Architecture, Superadmin Engine & Backend Hardening
- **Kushagra Garg** — Core Team Developer & API Integration
- **Mahak Katahara** — Core Team Developer & Frontend UI/Themes
- **Divyam Jain** — Core Team Developer & Systems Verification

---

## ⚠️ Known Issues & Roadmap

### Completed Milestones
- [x] Dual superadmin role lock (`vardaansaxena096@gmail.com` and `cicrinventory@gmail.com`).
- [x] Institutional student email validation (`@mail.jiit.ac.in`).
- [x] Mandatory admin approval gate barring unapproved student accounts from accessing dashboard or website.
- [x] Two-Factor Authentication (2FA) single-use 6-digit login verification OTP popup with 5-minute expiry.
- [x] Student lab section batches (e.g. F1, F2, B3) in registration with futuristic aesthetic placeholders.
- [x] Vercel same-origin API proxy rewrites resolving mixed-origin connectivity and CORS latency.
- [x] Hardware Issue Requests queue with multi-tier persistence.
- [x] Cyber-aesthetic transactional email redesign with instant admin CCs.
- [x] 60 FPS Sakura falling leaves engine and Avengers Assemble cinematic HUD.
- [x] Dynamic API URL resolution (automatic local vs. production routing).
- [x] Direct in-app inventory item deletion with cascading database removal and superadmin telemetry alerts.
- [x] Real-time System Audit & Activity Logs Center with category filters and instant search.
- [x] Automated 6-second background auto-synchronization between client and PostgreSQL.
- [x] Complete database mock data purge retaining strictly authentic vault inventory and authorized administrators.
- [x] Zero-latency optimistic 1-click issue request approvals and member authorizations with badge telemetry.
- [x] Hardware issue request de-duplication engine with composite content keying and atomic submit locking.
- [x] Tamper-proof read-only auto-fill for borrower identity details on hardware checkouts.
- [x] Full 54-component robotics hardware catalog with interactive stat filter buttons and 500-unit cap.
- [x] Resilient session recovery across Render cold starts and network failovers.
- [x] Modernized Meet The Developers showcase with verified GitHub and LinkedIn SVG links.

### Future Roadmap
- [ ] **QR Code Component Tagging**: Dynamic QR generation for instant hardware scanning on mobile devices.
- [ ] **Automated Export Engine**: CSV and PDF vault inventory reporting for annual club audits.
- [ ] **WebPush Notifications**: Browser-native push alerts for upcoming return deadlines.

---

## 📜 License

Distributed under the **MIT License**. Built with 🧠 + 🔧 by the **Creative & Innovative Cell in Robotics (CICR)**, JIIT-128.

<div align="center">

**© 2026 CICR Inventory Hub — Creative & Innovative Cell in Robotics**

[![Visit Vault](https://img.shields.io/badge/VISIT-VAULT-00f0ff?style=for-the-badge)](https://cicrinventory.vercel.app/)

</div>
