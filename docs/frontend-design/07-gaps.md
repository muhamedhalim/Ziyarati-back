# 07 — UX Gaps, Missing APIs & Backend Inconsistencies

Everything here is grounded in the actual source. Each item: what it blocks on the frontend, and a
recommended resolution. **Severity:** 🔴 blocker · 🟠 friction · 🟡 minor/clarity.

## A. Missing screens (backend exists, no obvious place — build these)
- 🟡 **Customer-facing payment-link page.** `GET /payment-links/token/:token` resolves a link, but
  it's gated by `payments.read` — a public payer can't open it. Either it needs a public variant or
  a BFF proxy. Build a `/pay/[token]` page but **flag** the auth mismatch (see D).
- 🟡 **Bulk WhatsApp import mapping UI** — `POST /whatsapp/contacts/bulk-import` exists; needs a
  column-mapping/preview screen.
- 🟡 **Role→user management surface** — endpoints exist (`/roles/:id/users/:userId`,
  `/roles/users/:userId`) but there's no "list users" endpoint (see B) to drive it.

## B. Missing APIs (UI needs them; backend has no endpoint)
- 🔴 **No "list users / staff users" endpoint.** You can `register-user`, assign roles, and read a
  user's roles (`GET /roles/users/:userId`), but there is **no `GET /users`**. The Settings ▸ Users
  screen cannot list staff accounts. *Resolution:* add `GET /users` (tenant-scoped) or derive from
  `GET /staff` (only covers staff *profiles*, not plain manager/receptionist users).
- 🔴 **Customer portal has no "my appointments" list.** `appointments.read_own` exists, but
  `GET /appointments` requires `appointments.read` (not granted to customers). There is no
  `GET /appointments/mine`. *Resolution:* add an ownership-scoped list endpoint, or the portal can
  only deep-link to a known appointment id.
- 🔴 **Patient identity is orphaned.** `register-patient` issues `type:"patient"` tokens that are
  **rejected by every tenant/staff endpoint**, and there are **no patient-scoped routes** at all.
  The "patient app" cannot do anything post-signup. *Resolution:* decide whether end users are
  `customer` RBAC users (then drop patient signup from the portal) or build a patient API surface.
- 🟠 **No customer activity timeline endpoint.** Profile ▸ Activity must be composed client-side
  from appointments/notes/contacts. *Resolution:* a `GET /crm/customers/:id/activity` aggregate.
- 🟠 **No finance summary for the Payments domain.** `/billing/summary` is SaaS-billing only.
  Payments dashboard KPIs are composed from list `total`s. *Resolution:* a payments summary
  aggregate (revenue, refunded, unsettled by period/branch).
- 🟠 **No cross-tenant/platform analytics.** Analytics is tenant-scoped; the super-admin dashboard
  has no MRR/revenue/active-clinic trend endpoint. *Resolution:* platform analytics aggregates.
- 🟠 **Reviews: no "needs reply" filter.** `GET /reviews` filters by customerId/minRating only;
  "unreplied" must be derived from the `reply` field per row (no server filter, no pagination by
  reply state). *Resolution:* add `hasReply` filter.
- 🟠 **No realtime transport.** No WebSocket/SSE in the backend. Inbox, handovers, payment status,
  campaign progress all rely on **polling**. *Resolution:* document polling intervals (done in
  `03`/`06`); consider SSE later.
- 🟡 **WhatsApp has no message store.** Sends live on `notification_logs` (channel WHATSAPP). The
  "conversation" thread (`/conversations`) and WhatsApp *sends* are **separate systems** — inbound
  customer WA messages arrive via webhook into conversations, but template/campaign sends are only
  visible in notification logs/analytics. The UI must not imply a single unified WA message ledger.
- 🟡 **Notifications module has no `notification-template`/`rule` create example for channels** —
  channel set is fixed (`WHATSAPP/SMS/EMAIL/PUSH/IN_APP`) but only WhatsApp is wired; show others as
  "not configured".

## C. Permission inconsistencies (verified in `rbac.constants.ts`)
- 🔴 **`featureflag.manage` is unreachable except via `*`.** No role lists it; only `super_admin`
  (wildcard) can `PUT /feature-flags`. Owners have `featureflag.read` only. The Feature-Flags edit
  UI must be **super-admin-only**, even though the controller lives in the clinic-facing
  subscription-billing module. *Resolution (product):* either grant owners `featureflag.manage` or
  move the screen to the platform console.
- 🟠 **Receptionist CRM asymmetry.** Has `crm.customers.manage` (write customers) and
  `crm.notes.manage`, `crm.files.manage`, but only `crm.tags.read` (no `crm.tags.manage`) and
  **not** `customers.manage`/`customers.read` (the non-CRM "customers.*" namespace). Two parallel
  customer permission namespaces exist (`customers.*` **and** `crm.customers.*`); the CRM
  controllers use `crm.customers.*`. UI should gate CRM screens on `crm.customers.*` and treat
  `customers.*` as legacy/unused by the CRM module. *Resolution:* confirm `customers.*` is dead or
  used elsewhere.
- 🟠 **Conversation analytics permission slug is generic.** `analytics.read`
  (`CONVERSATION_ANALYTICS_READ`) is a bare `'analytics.read'` string — distinct from
  `analytics.dashboard.read`. Easy to confuse; the gate for `/conversation-analytics/*` is
  `analytics.read`. Keep the constant, don't conflate with the Analytics module.
- 🟡 **Manager holds `platform.files.manage` and `platform.webhooks.read` but not API keys** — the
  Developer section for managers is read webhook logs + files; hide API keys.
- 🟡 **Refund read vs manage split.** `POST /refunds` = `refunds.manage` (owner), but `GET /refunds`
  = `payments.read`. Since only owner has `payments.read`, refunds are effectively owner-only
  anyway; no manager/receptionist refund visibility.

## D. Auth / tenant-state edge cases the UI must handle
- 🔴 **ActiveTenantGuard 403 storm.** A pending/rejected/suspended clinic returns 403 on *every*
  tenant route. Without a global boundary the whole app shows error cards. *Resolution:* the
  `<ActiveTenantBoundary>` in `03` — read `GET /tenants/me` once at boot and gate the shell.
- 🟠 **Refresh is one-time-use (rotation).** Concurrent 401s must funnel through a **single-flight**
  refresh or the second request invalidates the rotated token (replay → 401 → logout). Implemented
  in `03` `withRefreshRetry`.
- 🟠 **Payment-link token endpoint is permissioned** (`payments.read`) — a real payer link can't be
  public as-is (see A). Confirm intended audience.
- 🟡 **Super-admin login differs** — omit `tenantSlug`; staff/owner must pass `tenantSlug`. The
  login form needs a "platform admin" toggle or slug field. Same email can exist across clinics, so
  slug is required to disambiguate.
- 🟡 **`/auth/me` is the only permission source of truth** and re-reads roles each call — never
  cache permissions across login; re-fetch on focus after role changes.

## E. Data/enum clarity notes (not bugs, but the UI must know)
- 🟡 **`to` date bounds are exclusive** across all `from/to` filters — the date picker must add a
  day or send the next-day boundary, or users will "lose" the last day.
- 🟡 **Two invoice systems:** Payments `Invoice` (`/invoices`, InvoiceStatus) and SaaS
  `SubscriptionInvoice` (`/billing/invoices`, also InvoiceStatus). Different entities/screens — keep
  them in separate sections (done).
- 🟡 **Currency defaults are inconsistent in source:** tenants default `USD`, payments default
  `SAR`, appointment DTO default `USD`. Always resolve display currency from the **tenant settings**
  (`SAR` for the seed clinic), not from per-DTO defaults.
- 🟡 **AI cost is structurally 0** (`MODEL_PRICING_PER_1K.default = 0`, no provider wired,
  tenant+month cost granularity, no per-agent cost). Label AI cost "estimated"; don't build
  per-agent cost views.
- 🟡 **Free-varchar statuses** (conversation, AI conversation, training file, handover, WhatsApp
  template, notification) are app-constants, not DB enums — validate against the constants files
  (`*.constants.ts`) and treat unexpected values defensively in the StatusBadge map.
- 🟡 **Soft vs hard delete differs by module:** appointments/customers/services/campaigns/agents
  soft-delete; **conversations hard-delete** (CASCADE removes participants/messages). The delete
  confirm copy must reflect "permanent" for conversations.
- 🟡 **Customer `email` is globally unique and `phone` unique per tenant** (both required on create)
  — the create form must handle 409 on either with a field-level message.

## F. Recommended backend additions (priority order)
1. 🔴 `GET /users` (tenant-scoped) — unblocks Settings ▸ Users.
2. 🔴 `GET /appointments/mine` (`appointments.read_own`) — unblocks customer portal list.
3. 🔴 Decide patient vs customer identity; if keeping patients, add patient routes.
4. 🟠 `GET /crm/customers/:id/activity` — customer timeline.
5. 🟠 Payments summary + platform analytics aggregates — dashboards without `[compose]`.
6. 🟠 `hasReply` filter on `/reviews`; `hasCustomer`/unassigned already exist elsewhere.
7. 🟠 Public payment-link resolution (or BFF) for payers.
8. 🟢 SSE/WebSocket for inbox/handover/payment-status to replace polling.

Until these land, the frontend ships with the documented **`[compose]`** fallbacks and the
**polling** strategy; none of the gaps block the staff-facing app — they primarily constrain the
**customer/patient portal** and **platform financial analytics**.
