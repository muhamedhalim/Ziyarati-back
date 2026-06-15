# 01 — RBAC, Product Sitemap & Role-Based Navigation

Source of truth: `src/rbac/rbac.constants.ts` (roles, permissions, role→permission map) and the
`@RequirePermissions` / `@Roles` decorators on each controller.

## 1. Roles

| Slug | Name | Has tenant? | Summary |
|---|---|---|---|
| `super_admin` | Super Admin | **No** (`tenant_id = null`) | Platform operator. Holds the `*` wildcard = **every** permission, resolved dynamically. Logs in **without** `tenantSlug`. |
| `owner` | Clinic Owner | Yes | Full clinic control incl. payments/refunds/settlements, billing **manage**, users & roles. Excludes `tenants.manage` (platform) and customer self-service. |
| `manager` | Operations Manager | Yes | Appointments, customers, staff, scheduling, WhatsApp, AI, campaigns, notifications, analytics/reports. **No payments/refunds/invoices/settlements.** Billing/subscription **read-only**. No `users.manage`/`roles.manage`. |
| `receptionist` | Receptionist | Yes | Front desk: book/manage appointments, customer records (read+manage CRM customers/notes, read tags/files), WhatsApp send + conversations, AI handover read/manage. Read-only staff & scheduling. No payments, no campaigns-manage, no analytics. |
| `customer` | Customer | Yes (tenant-scoped end user) | Self-service only: `appointments.create`, `appointments.read_own` (ABAC), `reviews.create`, `profile.update_own` (ABAC). |

> **ABAC note:** `appointments.read_own` and `profile.update_own` are ownership-scoped — the
> server additionally checks record ownership. The UI must treat customer views as "mine only".

## 2. Permission matrix (effective per role)

`●` = granted. `super_admin` = all (`*`). Derived verbatim from `ROLE_PERMISSIONS`.

| Permission | owner | manager | reception | customer |
|---|:--:|:--:|:--:|:--:|
| appointments.create | ● | ● | ● | ● |
| appointments.read | ● | ● | ● | |
| appointments.read_own | | | | ● |
| appointments.update | ● | ● | ● | |
| appointments.reschedule | ● | ● | ● | |
| appointments.cancel | ● | ● | ● | |
| appointments.manage_all (delete) | ● | ● | | |
| reviews.read | ● | ● | ● | |
| reviews.create | | | | ● |
| reviews.manage (reply) | ● | ● | | |
| customers.* (create/read/update/manage) | ● | ● | create/read/update | |
| crm.customers.read / .manage | ● / ● | ● / ● | ● / ● | |
| crm.notes.read / .manage | ● / ● | ● / ● | ● / ● | |
| crm.tags.read / .manage | ● / ● | ● / ● | ● / — | |
| crm.files.read / .manage | ● / ● | ● / ● | ● / ● | |
| services.create/read/update/delete | ● | read only | | |
| staff.create/update/manage | ● | ● | | |
| staff.read | ● | ● | ● | |
| staff.schedule.manage / timeoff.manage | ● | ● | | |
| staff.commission.read / rating.read | ● | ● | | |
| scheduling.slots/blocked/holidays.read | ● | ● | ● | |
| scheduling.*.manage | ● | ● | | |
| scheduling.availability.read | ● | ● | ● | |
| payments.read / payments.manage | ● | | | |
| refunds.manage | ● | | | |
| invoices.read / invoices.manage | ● | | | |
| settlements.read / settlements.manage | ● | | | |
| reports.read / reports.export | ● / ● | read only | | |
| analytics.events/dashboard/reports.* | ● | ● | | |
| whatsapp.send | ● | ● | ● | |
| whatsapp.accounts.read / .manage | ● / ● | ● / ● | read only | |
| whatsapp.templates.read / .manage | ● / ● | ● / ● | read only | |
| whatsapp.contacts.read / .manage | ● / ● | ● / ● | ● / ● | |
| whatsapp.webhooks.manage | ● | ● | | |
| whatsapp.analytics.read | ● | ● | ● | |
| conversations.read / .manage | ● / ● | ● / ● | ● / ● | |
| messages.send / messages.read | ● | ● | ● | |
| participants.manage / attachments.manage | ● | ● | ● | |
| analytics.read (conversation analytics) | ● | ● | ● | |
| ai.chat / ai.manage | ● | ● | | |
| ai.agents/knowledge/training/prompts.read+manage | ● | ● | | |
| ai.conversations.read / .manage | ● / ● | ● / ● | read only | |
| ai.handover.read / .manage | ● / ● | ● / ● | ● / ● | |
| ai.analytics.read | ● | ● | | |
| subscription.read / .manage | ● / ● | read only | | |
| billing.read / .manage | ● / ● | read only | | |
| usage.read / featureflag.read | ● | ● | | |
| featureflag.manage | ● *(not granted — see gaps)* | | | |
| notifications.read / .manage | ● / ● | ● / ● | read only | |
| notification_templates.read / .manage | ● / ● | ● / ● | read only | |
| notification_rules.read / .manage | ● / ● | ● / ● | | |
| campaigns.read / .manage | ● / ● | ● / ● | read only | |
| campaign_recipients.read / .manage | ● / ● | ● / ● | read only | |
| campaign_analytics.read | ● | ● | ● | |
| platform.api-keys.read / .manage | ● | | | |
| platform.api-logs.read | ● | ● | | |
| platform.webhooks.read / .manage | ● / ● | read only | | |
| platform.files.read / .manage | ● / ● | ● / ● | | |
| platform.settings.read / .manage | *super_admin only* | | | |
| users.manage / roles.manage | ● | | | |
| tenants.manage | *super_admin only* | | | |

> **Gotchas the UI must respect (from source):**
> - `featureflag.manage` is **not** in any role's list except via the `*` wildcard → only
>   `super_admin` can write feature flags. Owners get `featureflag.read` only. The Feature Flags
>   "edit" UI must be hidden for owner/manager. (Flagged in `07-gaps.md`.)
> - Receptionist has `crm.customers.manage` (can create/edit CRM customers) but **lacks**
>   `customers.manage` and `crm.tags.manage` — show tag management read-only for them.
> - Manager has **no** payments domain at all — hide the entire Payments section.
> - `platform.settings.*` is enforced by `@Roles(super_admin)` at the controller level.

## 3. Product Sitemap

The app is one shell with three "spaces" selected by principal type at login:
**Clinic Workspace** (owner/manager/receptionist), **Platform Console** (super_admin), and the
**Customer Portal** (customer). Routes below are the Next.js App Router tree.

### 3.1 Clinic Workspace (`/app`)

```
/app
├── /dashboard                      Role-aware dashboard (see 06-dashboards.md)
│
├── /appointments
│   ├── /calendar                   Day / Week / Month calendar
│   ├── (list)                      Filterable appointment table
│   ├── /[id]                       Appointment detail (drawer or page)
│   │   ├── (overview / services / notes / timeline / review)
│   └── /reviews                    Reviews inbox (reply)
│
├── /crm
│   ├── /customers                  Customer list + search
│   ├── /customers/[id]             Profile (overview / profile / addresses / notes / files / tags / appointments / activity)
│   └── /tags                       Tag catalogue
│
├── /scheduling
│   ├── /availability               Availability explorer (check / windows / summary / validate)
│   ├── /slots                      Calendar slots
│   ├── /blocked-slots              Blocked periods
│   └── /holidays                   Holidays
│
├── /staff
│   ├── (list)                      Staff list
│   ├── /availability               "Who is bookable on date X at branch Y"
│   ├── /[id]                       Staff detail (profile / services / branches / schedules / time-off / commissions / ratings)
│   └── /working-hours              Tenant working-hours grid
│
├── /conversations                  Unified inbox
│   ├── /[id]                       Thread (messages / participants / attachments)
│   └── /analytics                  Conversation analytics
│
├── /whatsapp
│   ├── /accounts                   WhatsApp business accounts (per branch)
│   ├── /templates                  Template library + send/schedule
│   ├── /contacts                   Contacts + bulk import
│   ├── /webhooks                   Webhook subscriptions + retry
│   └── /analytics                  WhatsApp analytics
│
├── /ai
│   ├── /agents                     AI agents
│   ├── /agents/[id]                Agent config (prompt, model, branch)
│   ├── /knowledge-bases            KB chunks + rebuild
│   ├── /training-files             Training files (process / reprocess)
│   ├── /prompts                    Prompt management
│   ├── /conversations              AI conversations (+ messages)
│   ├── /handovers                  Handover request queue
│   └── /analytics                  Usage / cost / conversations / agents / knowledge
│
├── /campaigns
│   ├── (list)                      Campaign list
│   ├── /[id]                       Campaign detail (overview / recipients / performance)
│   └── /analytics                  Campaign analytics dashboard
│
├── /notifications
│   ├── /templates                  Notification templates
│   ├── /rules                      Trigger rules
│   ├── /scheduled                  Scheduled notifications
│   └── /logs                       Delivery log + statistics
│
├── /payments                       (owner only)
│   ├── (list)                      Payments
│   ├── /[id]                       Payment detail (+ confirm / status)
│   ├── /invoices                   Invoices (+ items / finalize)
│   ├── /refunds                    Refunds
│   ├── /transactions               Gateway transactions
│   ├── /settlements                Settlements (+ generate)
│   └── /payment-links              Payment links
│
├── /billing                        Subscription & SaaS billing
│   ├── /subscription               Current plan, change/cancel/reactivate, plans
│   ├── /invoices                   SaaS invoices (+ pay)
│   ├── /usage                      Usage vs plan caps
│   └── /feature-flags              Feature flags (read for owner/manager)
│
├── /analytics
│   ├── /dashboard                  Metrics dashboard (+ refresh)
│   ├── /events                     Event stream
│   ├── /reports/daily              Daily reports (+ generate)
│   └── /reports/monthly            Monthly reports (+ generate)
│
├── /settings
│   ├── /clinic                     Tenant profile (owner) — name/legal/contact/logo
│   ├── /operations                 Tenant settings (booking mode, payment required, cancellation hrs, language, currency, bot)
│   ├── /branches                   Branch management
│   ├── /verification               Verification documents (owner submits; status)
│   ├── /users                      Staff users (register-user, roles)
│   ├── /roles                      Roles & permissions (owner)
│   ├── /api-keys                   Platform API keys (owner)
│   ├── /files                      File uploads
│   └── /profile                    My account (change password, logout-all)
│
└── /developer                      API logs, webhook logs (owner/manager read)
```

### 3.2 Platform Console (`/platform`, super_admin)

```
/platform
├── /dashboard                      Platform KPIs (tenants by status, pending queue)
├── /tenants                        All tenants (filter by approval status, search)
│   └── /[id]                       Tenant detail (profile / settings / verification docs / approval events)
│       └── actions: approve / reject / suspend
├── /verification                   Verification queue (review docs across tenants)
├── /payment-gateways               Gateway config (Moyasar etc.)
├── /system-settings                Global system settings
├── /permissions                    Permission catalogue (create/update/delete)
└── /roles                          (system roles are read-mostly)
```

### 3.3 Customer Portal (`/portal`, customer)

```
/portal
├── /book                           Create appointment (availability-driven)
├── /appointments                   My appointments (read_own) — currently no list endpoint; see gaps
│   └── /[id]                       My appointment (reschedule/cancel if permitted) + leave review
└── /profile                        Update own profile
```

> The Customer Portal is **thin** — the backend exposes booking, own-appointment read, review
> create, and profile update, but **no `GET /appointments/mine` list** and **no patient-token
> endpoints**. See `07-gaps.md` §"Customer/Patient portal".

## 4. Role-Based Navigation (exact menus)

Each item maps to the permission that gates its first endpoint. Hide an item entirely if the
user lacks the permission; never render a dead link.

### Super Admin
`Dashboard · Tenants · Verification Queue · Payment Gateways · System Settings · Permissions`
(`tenants.manage` + `@Roles(super_admin)` everywhere; also implicitly holds all clinic perms via `*`).

### Owner
`Dashboard · Appointments · CRM · Scheduling · Staff · Conversations · WhatsApp · AI · Campaigns ·
Notifications · Payments · Billing · Analytics · Settings (Clinic, Operations, Branches,
Verification, Users, Roles, API Keys, Files) · Developer`
— the full clinic menu. Only platform-internal items are hidden.

### Manager
Same as Owner **minus**: `Payments` (whole section), `Settings ▸ Users`, `Settings ▸ Roles`,
`Settings ▸ API Keys`, `Settings ▸ Clinic profile edit` (read-only), `Services` create/edit
(read-only). Billing/Subscription/Feature-flags become **read-only**. Reports export hidden
(`reports.export` not granted).

### Receptionist
`Dashboard · Appointments · CRM (customers, notes; tags read-only; files) · Conversations ·
WhatsApp (send, contacts, templates read-only) · AI ▸ Handovers · Notifications (read) ·
Campaigns (read-only) · Staff (read-only) · Scheduling (read-only) · Settings ▸ Profile`
— **no** Payments, Billing, Analytics, AI agents/knowledge/prompts, Staff management,
Scheduling management.

### Customer
`Book · My Appointments · Profile` only.

### Menu→permission gate table

| Menu item | Gate permission | Roles that see it |
|---|---|---|
| Appointments | `appointments.read` | owner, manager, receptionist |
| Appointments ▸ Delete | `appointments.manage_all` | owner, manager |
| Reviews inbox | `reviews.read` | owner, manager, receptionist |
| Reviews ▸ Reply | `reviews.manage` | owner, manager |
| CRM ▸ Customers | `crm.customers.read` | owner, manager, receptionist |
| CRM ▸ Tags (edit) | `crm.tags.manage` | owner, manager |
| Scheduling (manage) | `scheduling.slots.manage` | owner, manager |
| Staff (list) | `staff.read` | owner, manager, receptionist |
| Staff (manage) | `staff.manage` | owner, manager |
| Payments | `payments.read` | **owner only** |
| Refunds / Settlements | `refunds.manage` / `settlements.manage` | owner |
| Billing ▸ Pay invoice | `billing.manage` | owner |
| Subscription ▸ Change/Cancel | `subscription.manage` | owner |
| Feature flags ▸ Edit | `featureflag.manage` | **super_admin only** |
| Conversations | `conversations.read` | owner, manager, receptionist |
| WhatsApp ▸ Accounts (manage) | `whatsapp.accounts.manage` | owner, manager |
| AI ▸ Agents | `ai.agents.read` | owner, manager |
| AI ▸ Handovers | `ai.handover.read` | owner, manager, receptionist |
| Campaigns (manage) | `campaigns.manage` | owner, manager |
| Analytics | `analytics.dashboard.read` | owner, manager |
| Reports ▸ Export | `reports.export` | owner |
| Settings ▸ Users | `users.manage` | owner |
| Settings ▸ Roles | `roles.manage` | owner |
| Settings ▸ API Keys | `platform.api-keys.read` | owner |
| Developer ▸ API/Webhook logs | `platform.api-logs.read` / `platform.webhooks.read` | owner, manager |
| Platform ▸ Tenants | `@Roles(super_admin)` | super_admin |
