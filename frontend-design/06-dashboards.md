# 06 — Dashboards (§5)

One role-aware `/app/dashboard` (clinic) + `/platform/dashboard` (super admin). Each widget below
names the **exact endpoint** it reads. Where the backend has no purpose-built aggregate, the widget
**composes** from list endpoints (using `total` + status filters) — these are flagged `[compose]`
and cross-referenced in `07-gaps.md`.

Shared widgets: `KpiCard` (value, delta, sparkline), `ChartCard` (Recharts), `DataTable` (compact),
`QuickActions` (permission-gated buttons), `ActivityFeed`.

---

## 1. Owner Dashboard

**Audience:** runs the whole clinic incl. money. Layout: KPI row → revenue/appointments charts →
operational tables → quick actions.

### KPI cards
| KPI | Source |
|---|---|
| Today's appointments | `GET /analytics/dashboard` (metric) or `[compose]` `GET /appointments?from=today&to=tomorrow` (use `total`) |
| Confirmed vs pending | `[compose]` `GET /appointments?status=CONFIRMED` / `=PENDING_PAYMENT` (`total`) |
| Revenue (period) | `GET /analytics/dashboard?metricKey=total_revenue`; fallback `[compose]` `GET /payments?status=PAID&from&to` |
| Unsettled balance | `[compose]` `GET /payments?settlementStatus=UNSETTLED&status=PAID` |
| Active subscription | `GET /subscriptions/current` (status badge) |
| Usage vs caps | `GET /usage` + plan caps |

### Charts
- **Appointments over time** (line) — `GET /analytics/reports/daily?from&to` or events.
- **Revenue trend** (bar) — daily/monthly reports.
- **Status mix** (donut) — `[compose]` per-status `total`.
- **Top services / staff utilization** — daily report payload / staff commissions summary.

### Tables
- **Today's schedule** — `GET /appointments?from&to&status` (compact).
- **Pending handovers** — `GET /ai/handovers?status=PENDING`.
- **Failed deliveries** — `GET /notification-logs?status=FAILED`.
- **Latest settlements** — `GET /settlements`.

### Quick actions
New appointment · New customer · Collect payment · Launch campaign · Generate settlement
(each gated; owner has all).

---

## 2. Manager Dashboard

Operations-focused — **no money widgets** (manager lacks payments). Same as Owner minus revenue/
unsettled/settlements; emphasizes throughput and team.

### KPI cards
Today's appointments `[compose]` · No-shows today (`status=NO_SHOW`) · Open conversations
(`GET /conversations?status=OPEN`) · Pending handovers (`/ai/handovers?status=PENDING`) ·
Campaigns running (`GET /campaigns?status=RUNNING`) · Reviews to reply
(`GET /reviews` filtered to no-reply — see gaps).

### Charts
Appointments over time + status mix (`analytics`), Staff utilization
(`/staff/:id/commissions/summary` per staff or daily report), Conversation response-time
(`/conversation-analytics/response-time`).

### Tables
Today's schedule · Unassigned conversations (`assignedToUserId=null`) · Pending handovers ·
Failed notifications.

### Quick actions
New appointment · New customer · Assign conversation · New campaign.

---

## 3. Receptionist Dashboard

Front-desk task list. Minimal analytics; high on "what needs me now".

### KPI / counters
| Counter | Source |
|---|---|
| Today's appointments | `[compose]` `GET /appointments?from=today&to=tomorrow` |
| Awaiting confirmation | `GET /appointments?status=PENDING_PAYMENT` |
| Unread conversations | `GET /conversations?status=OPEN` + unread |
| My/Pending handovers | `GET /ai/handovers?status=PENDING` (receptionist owns handover) |

### Lists (the working surface)
- **Today's appointments** (`GET /appointments?from&to`) with inline status actions
  (confirm → `POST /:id/status`, cancel, reschedule).
- **Inbox preview** (`GET /conversations`) — jump to thread.
- **Handover queue** (`GET /ai/handovers`) — accept/resolve.

### Quick actions
New appointment · New customer · Open inbox · Send WhatsApp template.

> No Payments, Analytics, Campaign-manage, or Staff-manage widgets (permissions absent).

---

## 4. Super Admin Dashboard (`/platform/dashboard`)

Platform health & onboarding throughput.

### KPI cards
| KPI | Source |
|---|---|
| Tenants total | `GET /tenants` (`total`) |
| Pending verification/approval | `[compose]` `GET /tenants?status=PENDING_VERIFICATION` / `=PENDING_APPROVAL` (`total`) |
| Approved (active) | `GET /tenants?status=APPROVED` |
| Suspended | `GET /tenants?status=SUSPENDED` |

### Tables / queues
- **Verification queue** — tenants with pending docs → `GET /verification-documents/tenants/:id`.
- **Recent tenant sign-ups** — `GET /tenants?search&page` sorted by created.
- **Webhook failures (platform)** — `GET /platform/webhook-logs?status=FAILED`.
- **API error rate** — `GET /platform/api-logs/stats`.

### Quick actions
Create tenant · Open verification queue · System settings · Permission catalogue.

> **Platform analytics gap:** there is no cross-tenant revenue/MRR endpoint (analytics is
> tenant-scoped). Platform financial dashboards would need a new backend aggregate. Flagged in
> `07-gaps.md`.

---

## Dashboard implementation notes
- Every `[compose]` KPI issues a `GET …?…&limit=1` and reads `total` (cheap count) — don't fetch
  full pages for counters.
- Poll counters (handovers, inbox, failed deliveries) every 15–30 s; charts/reports are not polled.
- All dashboards respect the ActiveTenant gate — if the clinic isn't approved/active, the dashboard
  is replaced by the onboarding/suspended shell (see `05` flow 1).
- Date ranges default to "this month" in the clinic's timezone; persist the selection.
