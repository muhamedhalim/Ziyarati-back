# 05 — Screens, Flows & Module Designs

Covers §3 (screen inventory), §4 (user flows), §6 (appointments), §7 (CRM), §8 (WhatsApp),
§9 (AI), §10 (payments), §11 (analytics). Each screen lists: Purpose · Route · Permission ·
Endpoints · Components · Actions · Empty/Loading/Error. Endpoints reference `04-api-reference.md`.

---

## A. Screen inventory contract

Every list screen shares one contract (don't re-spec it each time):

> **ListScreen<T>** — `FilterBar` (search + status + scope + date range) · `DataTable` (server
> `page/limit`, `total`) · row → `EntityDrawer`/detail · primary `Create` action (permission-gated)
> · **Loading** = row skeletons · **Empty** = "no data" vs "no results (clear filters)" ·
> **Error** = card + `message` + `requestId` + retry.

Below: the non-obvious screens and their specifics.

---

## B. End-to-end user flows (§4)

### 1. Tenant onboarding
1. **Sign-up** (`/register`, public) → `POST /auth/register-owner` (name, slug, CR number, owner
   email/password). Response = user + tenant (`approvalStatus = PENDING_VERIFICATION`) + tokens.
2. Auto-login → land on **`/app` onboarding shell** (not the dashboard). The shell is shown whenever
   `GET /tenants/me` returns `approvalStatus !== APPROVED || !isActive`.
3. **Stepper:** (a) Complete clinic profile (`PATCH /tenants/me`), (b) Upload verification docs
   (`POST /verification-documents/me` per doc: `commercial_registration`, `national_id`, `license`,
   …; each is a storage URL), (c) Choose plan (`GET /subscriptions/plans` → `POST /subscriptions`,
   optional `startTrial`), (d) "Submitted — under review".
4. **Waiting state:** poll `GET /tenants/me` + `GET /verification-documents/me` (per-doc PENDING/
   APPROVED/REJECTED). If a doc is REJECTED → show reviewer note → re-upload.
5. Super admin approves → `approvalStatus = APPROVED`, `isActive = true` → next `GET /tenants/me`
   flips the gate → full workspace unlocks.

> **Flow gap (flag):** `register-owner` sets status `PENDING_VERIFICATION`, but the only
> super-admin transition is `approve/reject/suspend` (no explicit "move to PENDING_APPROVAL").
> Treat both PENDING_* as one "under review" UI state. (See `07-gaps.md`.)

### 2. Verification (super admin side)
Platform ▸ Verification queue → list tenants with pending docs → open tenant →
`GET /verification-documents/tenants/:tenantId` → per doc **Approve/Reject**
(`PATCH /verification-documents/:documentId/review`) → when satisfied,
`POST /tenants/:id/approve` (optional reason). Reject path: `POST /tenants/:id/reject`.

### 3. Subscription
Billing ▸ Subscription: `GET /subscriptions/current` + `GET /subscriptions/plans`. Actions:
subscribe (`POST /subscriptions`), **change plan** (`POST /subscriptions/change-plan`), **cancel**
(`POST /subscriptions/cancel`, CancelSubscriptionDto reason), **reactivate**
(`POST /subscriptions/reactivate`). Status badge from `SubscriptionStatus`. Usage tab:
`GET /usage` + `/breakdown` vs plan caps (max_branches/users/ai_tokens/whatsapp_messages/
appointments/campaigns).

### 4. Customer management
CRM ▸ Customers: `GET /crm/customers/search` (q, tagIds, isActive). Create
(`POST /crm/customers` — phone+email required, unique). Open profile (§D CRM).

### 5. Appointment booking (§6 detail below)
Booking modal: pick branch → date → **bookable staff** (`GET /staff/availability?branchId&date`) →
**free windows** (`GET /scheduling/availability/windows`) → services (sets duration/price) →
optional `validate` → `POST /appointments` (initial `PENDING_PAYMENT`). 409 if staff busy.

### 6. Reschedule
Detail ▸ Reschedule modal → new start (+ optional end) → `POST /appointments/:id/reschedule`
(reason). Conflict-checked (409 "staff busy in new window"). Terminal appts blocked.

### 7. Cancellation
Detail ▸ Cancel modal → reason + optional `refundAmount` (audit only) →
`POST /appointments/:id/cancel`. Status → CANCELLED. Refund itself is a Payments action.

### 8. Staff management
Settings ▸ Users ▸ invite (`POST /auth/register-user`, manager/receptionist) → Staff ▸ Create
(`POST /staff` links that user) → configure services/branches/schedules/time-off/commissions
(§D Staff).

### 9. WhatsApp messaging (§8 detail below)
Inbox thread → composer (`POST /conversations/:id/messages`), or send a **template**
(`POST /whatsapp/templates/:id/send`) to a contact/customer/raw number. Delivery tracked on
notification logs.

### 10. AI assistant (§9 detail below)
Configure agent (model, prompt, branch, temperature) → add knowledge (training files → process →
indexed; KB chunks) → AI conversations; escalate to human via **handover**.

### 11. Campaign creation
Campaigns ▸ Create (DRAFT) → add recipients (`POST /campaigns/:id/recipients`) → schedule
(`POST /campaigns/:id/schedule`) or **launch** (`POST /campaigns/:id/launch`) → monitor recipients
(QUEUED→SENT→DELIVERED→READ/FAILED) → pause/resume/cancel/retry.

### 12. Payment collection (§10 detail below)
Payments ▸ Collect (`POST /payments`, idempotencyKey) → confirm (`POST /payments/:id/confirm`) →
poll status. Or generate a **payment link** to share.

### 13. Refund processing
Payments ▸ payment detail ▸ Refund modal → amount (omit = full remaining) + reason →
`POST /refunds`. Payment status → REFUNDED/PARTIALLY_REFUNDED.

### 14. Settlement workflow
Payments ▸ Settlements ▸ Generate → period + branch + feePercent → `POST /settlements/generate`
(aggregates UNSETTLED PAID payments into one batch; gross/fee/net). Payout status lifecycle
PENDING→PROCESSING→PAID/FAILED. Payments move UNSETTLED→IN_BATCH→SETTLED.

### 15. Analytics reporting (§11 detail below)
Dashboard (`GET /analytics/dashboard`) → generate daily/monthly reports → export where
`reports.export`.

---

## C. §6 — Appointment System

### C1. Calendar (`/app/appointments/calendar`)
- **Permission:** `appointments.read`. **Endpoint:** `GET /appointments?from&to&branchId&staffId&status`.
- **Views:** Day / Week / Month toggle.
  - *Day:* staff columns (resource view); each column shows that staff's appointments; overlay
    **blocked slots** (`GET /scheduling/blocked-slots`), **holidays** (`/scheduling/holidays`), and
    **free windows** (`/scheduling/availability/windows`) as background.
  - *Week:* 7-day grid, current branch + optional staff filter.
  - *Month:* day cells with count + status mix bar; click → Day view for that date.
- **Data fetch:** range = visible window → `from`/`to`. Branch filter required for resource view
  (timezone from branch). Re-fetch on view/range/filter change; `keepPreviousData`.
- **Components:** `CalendarToolbar` (range nav, view toggle, branch/staff filters, "New"),
  `CalendarGrid`, `AppointmentChip` (StatusBadge color), `NowLine`.
- **Actions:** click empty slot → Booking modal prefilled (branch, staff, start). Click chip →
  Appointment drawer. Drag to reschedule → Reschedule modal confirm (no silent optimistic — server
  may 409).
- **States:** Loading = ghost grid; Empty = "No appointments in this range"; Error = inline card.

### C2. Appointment list (`/app/appointments`)
- `GET /appointments` with full filter bar: status (enum), branch, staff, customer (customer picker
  via `/crm/customers/search`), date range. Ordered start_at desc (server).
- Columns: when (start–end, branch tz) · customer · staff · services (chips, +N) · status ·
  total (Money) · source · actions (view/reschedule/cancel/status — permission-gated).

### C3. Appointment Detail Drawer (`/app/appointments/[id]`)
Right drawer, 560px, tabs:
- **Overview:** `GET /appointments/:id` — header (status, when, branch, customer, staff),
  totals, source, notes. Status stepper showing the **state machine**:
  `PENDING_PAYMENT → CONFIRMED | NO_SHOW`; `CONFIRMED → IN_PROGRESS | COMPLETED | NO_SHOW`;
  `IN_PROGRESS → COMPLETED`; `RESCHEDULED → CONFIRMED | NO_SHOW`. Only legal next states are
  enabled (`POST /appointments/:id/status`). **CANCELLED is never here** — uses Cancel modal.
- **Services:** list with price/duration; **Edit** (`PUT /appointments/:id/services`) recomputes
  end_at + total. Blocked on terminal status.
- **Notes:** `GET/POST /appointments/:id/notes` — internal staff notes feed, author server-set.
- **Timeline:** `GET /appointments/:id/timeline` — merged feed (created · status_log · history ·
  note · reschedule · cancellation), each `{type, at, data}` → `TimelineFeed`.
- **Review:** `GET /appointments/:id/review` (one per appointment).
- **Actions bar:** Reschedule · Cancel · (Edit staff/branch via `PATCH`) · Delete (only
  CANCELLED/NO_SHOW, `appointments.manage_all`).

### C4. Create Appointment Modal
Fields ← `CreateAppointmentDto`: branchId, customerId, staffId, startAt (ISO+offset), endAt?,
serviceIds[]?, source (default MANUAL), currency (default tenant), notes (≤2000). Live helpers:
availability `check`/`validate` before submit; show computed end/total from chosen services.
Errors: 404 (cross-tenant ref), 409 (overlap), 400 (no endAt and no services).

### C5. Reschedule / Cancellation flows — see B6/B7. Both write audit rows surfaced in Timeline.

### C6. Reviews (`/app/appointments/reviews`)
`GET /reviews?customerId&minRating` → list with rating stars, comment, reply state. **Reply**
(`POST /reviews/:id/reply`, `reviews.manage`). Customers create via portal
(`POST /appointments/:id/review`; appointment must be COMPLETED → 422 otherwise; one per appt → 409).

---

## D. §7 — CRM

### D1. Customer List (`/app/crm/customers`)
`GET /crm/customers/search` (q matches name/email/phone, tagIds[], isActive). Columns: name +
phone/email · tags (TagChips) · marketing opt-in · active · created. Create modal ←
`CreateCustomerDto` (full_name?, **phone** required unique-per-tenant, **email** required globally
unique, whatsapp_id/name?, gender?, date_of_birth?, source?, marketing_opt_in, is_active).

### D2. Customer Profile (`/app/crm/customers/[id]`)
Full page, left summary + tabbed right:
- **Overview:** `GET /crm/customers/:id` — identity, contact, opt-in, active; quick actions
  (book appointment, message on WhatsApp, edit, delete).
- **Medical profile:** `GET/PUT /crm/customers/:id/profile` (medical_history, allergies,
  blood_type, emergency_contact_name/phone, notes). Gate `crm.customers.read/manage`.
- **Addresses:** `…/addresses` CRUD.
- **Notes:** `…/notes` CRUD (`crm.notes.*`), author server-set, newest first.
- **Files:** `…/files` (upload via storage → URL; list/download/delete; `crm.files.*`).
- **Tags:** `…/tags` relations (add from catalogue, remove; `crm.tags.manage`).
- **Appointments:** `GET /appointments?customerId=:id` (reuse list).
- **Activity timeline:** *No customer-level timeline endpoint exists.* Compose client-side from
  appointments + notes + WhatsApp contact (and, where permitted, payments/conversations). Flag in
  gaps; present as "Recent activity" assembled from available lists.

### D3. Tags (`/app/crm/tags`)
`GET /crm/tags?q` catalogue; create/edit/delete (`crm.tags.manage`). Tag color stored per tag →
drives TagChip.

---

## E. §8 — WhatsApp / Conversations

### E1. Unified Inbox (`/app/conversations`)
Two-pane page.
- **Left list:** `GET /conversations` filters: status (BOT/OPEN/ASSIGNED/RESOLVED/ARCHIVED/CLOSED),
  type (direct/group/support/automation), assignedToUserId (Me / unassigned / agent), customerId,
  branchId, participantUserId, date range. Row: customer/contact, last message preview,
  `last_message_at`, unread CountBadge, status.
- **Right thread:** header (`GET /conversations/:id`) + messages
  (`GET /conversations/:conversationId/messages?senderType&messageType&from&to`, limit 50). Group by
  day; bubble alignment by senderType (CUSTOMER/AGENT/BOT/SYSTEM). Per-message delivery dot
  (SENT/DELIVERED/READ/FAILED from status logs). Mark read (`POST /…/messages/:id/read`).
- **Composer:** `POST /conversations/:conversationId/messages` (content ≤8000, messageType default
  text, senderType default AGENT). Attachments: create attachment (URL) then send image/file.
- **Thread actions:** Assign (`/assign`), Archive/Unarchive, Resolve/Close (via `PATCH status`),
  Delete (hard), manage Participants (`/participants`).
- **Bulk:** select conversations → `POST /conversations/bulk-message`.
- **Handover affordance:** "Escalate to human" → `POST /ai/handovers` (links this conversation).

### E2. Contact Profile (drawer)
`GET /whatsapp/contacts/:id` — wa_id, display name, linked customer (or "link to customer").
Edit/delete (`whatsapp.contacts.manage`).

### E3. WhatsApp ▸ Accounts (`/app/whatsapp/accounts`)
Per-branch account. List (branchId, isActive). Create ← `CreateWhatsappAccountDto` (branchId,
phoneNumberId?, wabaId?, accessToken **write-only**, isActive). Detail shows **connection status**
(`GET /…/:id/connection-status`) as a live badge; activate/deactivate; rotate token = re-enter
(never displayed). One account per branch (unique).

### E4. Templates (`/app/whatsapp/templates`)
List (status, category, language, search). Create ← `CreateWhatsappTemplateDto` (name, language,
category?, components JSON, accountId?, status default draft). Status lifecycle
draft→pending_review→approved/rejected/disabled (`PATCH /:id/status`). **Send**
(`POST /:id/send`, `SendTemplateMessageDto`: one of contactId/customerId/toWaId, variables map,
idempotencyKey) and **Schedule** (`POST /:id/schedule`, scheduledAt).

### E5. Contacts (`/app/whatsapp/contacts`) + **Bulk import** (`POST /whatsapp/contacts/bulk-import`).

### E6. Delivery tracking & status indicators
There is **no WhatsApp message table** — sends are recorded on `notification_logs` (channel
WHATSAPP). So "delivery tracking" reads from Notifications ▸ Logs and WhatsApp ▸ Analytics, **not**
a per-message WA store. Surface: per-send status (QUEUED/SENT/DELIVERED/READ/FAILED) in the logs
view filtered by channel=WHATSAPP / templateId.

### E7. WhatsApp ▸ Analytics (`/app/whatsapp/analytics`)
`overview` (KPIs) · `templates` (per-template volume) · `engagement` · `accounts` — all `from/to`,
`templateId?`. Render as KPI cards + bar/line charts.

### E8. Conversation Analytics (`/app/conversations/analytics`)
`overview` · `messages` · `agents` (per-agent, assignedToUserId) · `response-time` — `from/to`.

---

## F. §9 — AI

### F1. Agents (`/app/ai/agents`, `/[id]`)
List (search, model, isActive). Create/edit ← `CreateAiAgentDto` (name?, model?, systemPrompt?,
temperature 0..2 default 0.2, branchId?, isActive). Activate/deactivate; delete (soft).
Detail page = config form + linked prompts + KB + training files + recent AI conversations.
> Lifecycle note (from `ai.constants`): only `is_active` + soft-delete exist — there is **no
> "draft" agent state**; "archived" = soft-deleted.

### F2. Knowledge Base (`/app/ai/knowledge-bases`)
A row = a **knowledge chunk** per agent (no name/status column). List (agentId, search over
content). Create/edit/delete chunks. **Rebuild index** (`POST /ai/knowledge-bases/rebuild`).

### F3. Training Files (`/app/ai/training-files`)
List (agentId, status). Upload ← `UploadTrainingFileDto` (file URL; types PDF/DOCX/TXT/MD).
Status UPLOADED→PROCESSING→INDEXED/FAILED. Actions: **process** / **reprocess**. Show progress +
failure reason; INDEXED feeds the KB.

### F4. Prompts (`/app/ai/prompts`)
List (agentId, search, isActive). CRUD + activate/deactivate. (No type/version persisted — don't
build versioning UI.)

### F5. AI Conversations (`/app/ai/conversations`)
List (status ACTIVE/COMPLETED/HANDED_OVER/ARCHIVED, agentId). Detail = message thread
(role user/assistant/system). Post message (`/:id/messages`), close, archive.

### F6. Handover Requests (`/app/ai/handovers`)
Queue (status PENDING/ASSIGNED/ACCEPTED/RESOLVED/REJECTED, assignedToUserId). This is the
**receptionist's main AI touchpoint** (`ai.handover.*`). Create from a conversation; actions:
assign (AssignHandoverDto), accept, resolve, reject (with reason). Resolving can flip the linked AI
conversation to HANDED_OVER. Show PENDING count as a nav CountBadge.

### F7. AI Analytics (`/app/ai/analytics`)
`usage` (tokens/messages) · `cost` · `conversations` · `agents` · `knowledge` — `from/to`.
> Cost note: `MODEL_PRICING_PER_1K` defaults to 0 and `ai_cost_logs` is tenant+month granularity
> (no per-agent cost). Render cost as month buckets; expect 0 until a real provider is configured —
> label it "estimated" and don't promise per-agent cost. (Gaps.)

---

## G. §10 — Payments (owner only)

### G1. Financial Dashboard (Payments landing)
KPI cards from `GET /payments` aggregates (by status), unsettled total (settlement_status=UNSETTLED),
refunds, latest settlements. (No dedicated finance-summary endpoint beyond `/billing/summary` for
SaaS billing — compose from payments/refunds/settlements lists. Flag in gaps.)

### G2. Payments (`/app/payments`, `/[id]`)
List (status, settlementStatus, customerId, from, to). Detail drawer: amount/currency, status,
gateway, settlement status, paid_at, linked appointment/customer/branch. Actions: **Confirm**
(`POST /:id/confirm`), **Status poll** (`GET /:id/status`), **Refund** (→ Refunds).
Collect modal ← `CreatePaymentDto` (amount, currency default SAR, gateway default moyasar,
customerId?, appointmentId?, branchId?, description?, callbackUrl?, idempotencyKey).

### G3. Invoices (`/app/payments/invoices`)
List (status DRAFT/OPEN/PAID/VOID/UNCOLLECTIBLE/REFUNDED, customerId, from, to). Create (DRAFT) →
add items (`POST /:id/items`) → **Finalize** (`POST /:id/finalize` → OPEN). Detail with line items
and totals.

### G4. Refunds (`/app/payments/refunds`)
List (paymentId, status). Create ← `CreateRefundDto` (paymentId, amount? omit=full, reason?).
Read needs only `payments.read`; create needs `refunds.manage`.

### G5. Transactions (`/app/payments/transactions`)
Read-only gateway transactions (paymentId, type charge/verify/webhook/refund, status). Used as the
audit trail under a payment.

### G6. Settlements (`/app/payments/settlements`)
List (status PENDING/PROCESSING/PAID/FAILED, from, to). **Generate** modal ←
`GenerateSettlementDto` (periodStart?, periodEnd?, branchId?, feePercent 0..100, currency). Detail:
gross/fee/net, period, branch, items (the rolled-up payments). Lifecycle as in §B14.

### G7. Payment Links (`/app/payments/payment-links`)
List (status). Create ← `CreatePaymentLinkDto` (amount, appointmentId?, expiresAt? default +72h).
Disable (`POST /:id/disable`). Public-facing resolution by token (`GET /payment-links/token/:token`).

### G8. Payment Gateways (Platform, super_admin)
`/payment-gateways` CRUD (`@Roles(super_admin)`) — Moyasar config. Not in clinic UI.

---

## H. §11 — Analytics

### H1. Dashboard (`/app/analytics/dashboard`)
`GET /analytics/dashboard?metricKey?` returns pre-aggregated `DashboardMetric` rows (key/value).
Render as KPI grid + a **Refresh** action (`POST /analytics/dashboard/refresh`,
`analytics.reports.manage`). Optional single-metric filter.

### H2. Events (`/app/analytics/events`)
`GET /analytics/events` (eventType, entityType, branchId, from, to) — raw event stream table for
power users. `POST /analytics/events` is for tracking (server/client emit), not a UI form.

### H3. Reports
- **Daily** (`/app/analytics/reports/daily`): list (branchId, from, to; default limit 31),
  generate (`POST /…/daily/generate`, `analytics.reports.manage`), detail by id.
- **Monthly** (`/app/analytics/reports/monthly`): list (branchId, month YYYY-MM; default limit 12),
  generate, detail.
- **Export:** gated by `reports.export` (owner only) — CSV/print from the loaded report.

### H4. Filters / date ranges / export (shared)
- Date range picker emits ISO-8601; `to` is exclusive everywhere — the picker's "end of day" must
  send next-day 00:00 or the documented exclusive bound.
- Daily/monthly use **date-only** formats (`YYYY-MM-DD`, `YYYY-MM`); events/most analytics use full
  ISO timestamps. The DateRangeFilter has a `granularity` prop to match.
- Branch filter is a shared control; persist last selection in `filtersStore`.

---

## I. Remaining inventory (settings, platform, billing, notifications)

| Screen | Route | Perm | Key endpoints |
|---|---|---|---|
| Clinic profile | /app/settings/clinic | owner | `PATCH /tenants/me` |
| Operations settings | /app/settings/operations | owner/manager | `GET/PATCH /tenants/me/settings` (bookingConfirmation AUTO/MANUAL, paymentRequired, cancellationHours, feedbackDelayMinutes, language, currency, botEnabled) |
| Branches | /app/settings/branches | owner/manager | `/branches` CRUD |
| Verification | /app/settings/verification | owner | `/verification-documents/me` |
| Users | /app/settings/users | owner | `/auth/register-user`, `/roles/users/:userId`, role assign |
| Roles | /app/settings/roles | owner | `/roles`, `/roles/:id/permissions`, `/permissions` (read) |
| API keys | /app/settings/api-keys | owner | `/platform/api-keys` (+rotate/revoke/activate/deactivate) |
| Files | /app/settings/files | owner/manager | `/platform/files` (+usage) |
| Profile | /app/settings/profile | auth | `/auth/change-password`, `/auth/logout-all`, `/auth/me` |
| API logs | /app/developer/api-logs | owner/manager | `/platform/api-logs` (+stats) |
| Webhook logs | /app/developer/webhook-logs | owner/manager(read) | `/platform/webhook-logs` (+retry owner/manager-manage) |
| Notifications ▸ Templates/Rules/Scheduled/Logs | /app/notifications/* | manage/read per resource | see `04` Notifications |
| Billing ▸ Subscription/Invoices/Usage/Feature-flags | /app/billing/* | subscription/billing/usage/featureflag | see `04` Billing |
| Platform ▸ Tenants/Verification/Gateways/System settings/Permissions | /platform/* | super_admin | see `04` Tenants/Platform |
