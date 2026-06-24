# Ziyarati — Frontend System Design

> Reverse-engineered from the NestJS backend in this repository. Every endpoint, permission,
> status value, filter, and workflow referenced here is taken from the actual source
> (`src/modules/**`, `src/rbac/rbac.constants.ts`, `src/entities/**`). Nothing is invented.
> Where the backend is incomplete or inconsistent, it is **flagged explicitly** (see `07-gaps.md`).

## What this platform is

A **multi-tenant SaaS for clinics** (the tenant = a "Clinic"). Each clinic runs appointments,
staff, a CRM, WhatsApp messaging, an AI assistant, marketing campaigns, payments, billing, and
analytics. A **platform operator** (`super_admin`) onboards, verifies, approves, suspends, and
monitors clinics. End users (**customers/patients**) book and review appointments.

Two distinct identity models exist in the backend:
- **Staff/Owner/Manager/Receptionist + Customer** — RBAC users that belong to a `tenant_id`
  (customers are RBAC users scoped to a tenant), authenticated with `type: "access"` JWTs.
- **Patients** — a *separate* B2C table with **no tenant and no RBAC roles**, authenticated with
  `type: "patient"` JWTs that are rejected by every tenant/staff endpoint. (See gaps doc — the
  patient portal has almost no dedicated backend surface yet.)

## Tech stack (target)

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript |
| Server state | TanStack React Query |
| Client state | Zustand |
| Styling | Tailwind CSS |
| Components | shadcn/ui (Radix primitives) |
| Forms | react-hook-form + zod |
| Charts | Recharts |
| Tables | TanStack Table |
| i18n | next-intl (Arabic + English, **RTL-first** — clinics default to `ar`/`SAR`) |
| Dates | day.js with UTC + timezone plugins (all API times are ISO-8601 `timestamptz`) |

## How to read this package

| File | Covers (spec sections) |
|---|---|
| `01-rbac-and-navigation.md` | Roles, permission matrix, product sitemap, role-based navigation (§1, §2) |
| `02-design-system.md` | Colors, type, spacing, tables, forms, modals, drawers, badges, status colors, permission-based UI rules (§12) |
| `03-frontend-architecture.md` | Folder structure, feature modules, API layer, hooks, state, route/permission guards, shared components (§13) |
| `04-api-reference.md` | Full endpoint catalog by module, with verb/path/permission/DTO and where each is used (§14) |
| `05-screens-and-flows.md` | Screen inventory + end-to-end user flows + per-module designs (Appointments, CRM, WhatsApp, AI, Payments, Analytics) (§3, §4, §6, §7, §8, §9, §10, §11) |
| `06-dashboards.md` | Owner / Manager / Receptionist / Super Admin dashboards, widget→endpoint mapping (§5) |
| `07-gaps.md` | Missing screens, missing APIs, backend inconsistencies, permission issues, UX blockers (§15) |

## Global API conventions (verified in source)

- **Base path:** controllers are mounted under a global prefix (e.g. `/api/v1`). All paths in
  `04-api-reference.md` are relative to that prefix.
- **Auth:** `Authorization: Bearer <accessToken>`. Access token ~15 min, refresh ~7 days,
  **one-time-use rotation** at `POST /auth/refresh` (replay returns 401). On any 401 from a
  protected call → refresh once → retry → else logout.
- **Tenant scoping:** never sent by the client. The server derives `tenantId` from the JWT
  principal (`TenantContext`). There is **no `tenantId` field on any create/update DTO**.
- **Guards stack:** `JwtAuthGuard` → `PermissionsGuard`/`RolesGuard` → `ActiveTenantGuard`
  (the clinic must be `APPROVED` + `is_active`). A suspended/rejected/pending clinic returns
  **403 "Tenant is not active"** on tenant routes even with a valid token — the app shell must
  handle this globally (see `05` onboarding flow + `02` permission rules).
- **Pagination:** list endpoints accept `page` (default 1) and `limit` (default 20, max 100 —
  a few use max 200/limit 50). Responses are `{ data, total, page, limit }`.
- **Filtering/search:** consistent query params per resource — `search`/`q`, `status`,
  date ranges `from`/`to` (ISO-8601, `to` is **exclusive**), and scoping ids
  (`branchId`, `staffId`, `customerId`). Booleans are passed as the strings `"true"`/`"false"`.
- **Errors:** uniform body `{ statusCode, errorCode, message, requestId, timestamp }`.
  Surface `message` to users and log `requestId` for support.
- **Public endpoints:** `register-owner`, `register-patient`, `login`, `refresh`, `logout`,
  `forgot-password`, `reset-password`, the WhatsApp webhook (`/whatsapp/webhooks/*`), and the
  Moyasar payment webhook (`/payments/webhooks/moyasar`). Webhooks are server-to-server — not
  part of the UI.
