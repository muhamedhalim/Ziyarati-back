# 02 — Design System

A clinic-grade, **RTL-first** (Arabic default) admin design system. Calm, dense-but-legible,
status-driven. Built on Tailwind + shadcn/ui tokens so it themes per tenant (logo, accent).

## 1. Color

Use CSS variables (HSL) so tenants can override the accent. Default palette:

```css
:root {
  /* Brand */
  --primary: 174 72% 36%;        /* teal-600 — clinic/health, calm trust */
  --primary-foreground: 0 0% 100%;
  --accent: 199 89% 48%;         /* sky-500 — links, focus */

  /* Neutrals */
  --background: 0 0% 100%;
  --foreground: 222 22% 14%;
  --muted: 220 14% 96%;
  --muted-foreground: 220 9% 46%;
  --border: 220 13% 91%;
  --card: 0 0% 100%;
  --ring: 199 89% 48%;

  /* Semantic */
  --success: 142 71% 40%;
  --warning: 38 92% 50%;
  --danger: 0 72% 51%;
  --info: 199 89% 48%;
  --radius: 0.625rem;
}
.dark { --background: 222 22% 10%; --foreground: 210 20% 96%; --card: 222 20% 13%;
        --muted: 222 16% 18%; --border: 222 14% 22%; /* …semantic stay, lift L by ~6% */ }
```

Money/financial screens (Payments, Settlements, Billing) use a slightly cooler neutral surface to
signal "ledger". Destructive actions always use `--danger`.

## 2. Status colors (canonical — drive every Badge)

Map each backend enum value to **one** semantic token. The same color = same meaning everywhere.

| Domain · value | Token | Visual |
|---|---|---|
| **Tenant** PENDING_VERIFICATION / PENDING_APPROVAL | warning | amber |
| APPROVED | success | green |
| REJECTED | danger | red |
| SUSPENDED | neutral-strong | slate (with red dot) |
| **VerificationDoc** PENDING | warning | amber |
| APPROVED / REJECTED | success / danger | green / red |
| **Subscription** TRIAL | info | sky |
| ACTIVE | success | green |
| PAST_DUE | warning | amber |
| CANCELLED / SUSPENDED | neutral / danger | slate / red |
| **Invoice** DRAFT | neutral | slate |
| OPEN | info | sky |
| PAID | success | green |
| VOID / UNCOLLECTIBLE | neutral / danger | slate / red |
| REFUNDED | violet | purple |
| **Appointment** PENDING_PAYMENT | warning | amber |
| CONFIRMED | info | sky |
| IN_PROGRESS | primary | teal |
| COMPLETED | success | green |
| CANCELLED | neutral | slate |
| NO_SHOW | danger | red |
| RESCHEDULED | violet | purple |
| **Payment** PENDING | warning |
| PAID | success |
| FAILED | danger |
| REFUNDED / PARTIALLY_REFUNDED | violet |
| **Settlement(payment.settlement_status)** UNSETTLED / IN_BATCH / SETTLED | neutral / info / success |
| **Payout(settlement.status)** PENDING / PROCESSING / PAID / FAILED | warning / info / success / danger |
| **Campaign** DRAFT | neutral |
| SCHEDULED | info |
| RUNNING | primary (pulse) |
| PAUSED | warning |
| COMPLETED | success |
| CANCELLED | neutral |
| **Recipient** QUEUED / SENT / DELIVERED / READ / FAILED / SKIPPED | neutral / sky / info / success / danger / slate |
| **Conversation** BOT | violet |
| OPEN | info |
| ASSIGNED | primary |
| RESOLVED / CLOSED | success |
| ARCHIVED | neutral |
| **Message status** SENT / DELIVERED / READ / FAILED | slate / sky / success / danger |
| **WhatsApp template** draft / pending_review / approved / rejected / disabled | neutral / warning / success / danger / slate |
| **Training file** UPLOADED / PROCESSING / INDEXED / FAILED | neutral / info(pulse) / success / danger |
| **AI conversation** ACTIVE / COMPLETED / HANDED_OVER / ARCHIVED | primary / success / warning / neutral |
| **Handover** PENDING / ASSIGNED / ACCEPTED / RESOLVED / REJECTED | warning / info / primary / success / danger |
| **Notification** PENDING/SCHEDULED / PROCESSING / SENT/DELIVERED / FAILED / CANCELLED | warning / info / success / danger / neutral |

`<StatusBadge domain="appointment" value="NO_SHOW" />` — a single component holds this map so a new
enum value never needs a screen-by-screen change.

## 3. Typography

System/Arabic-friendly stack. Headings tighter, body comfortable for long Arabic strings.

```
font-sans: "IBM Plex Sans Arabic", "Inter", ui-sans-serif, system-ui;
font-mono: "IBM Plex Mono", ui-monospace;   /* ids, tokens, amounts in ledgers */
```

| Token | Size / line / weight | Use |
|---|---|---|
| display | 30/36, 700 | page hero (dashboards) |
| h1 | 24/32, 700 | page title |
| h2 | 20/28, 600 | section |
| h3 | 16/24, 600 | card title |
| body | 14/22, 400 | default |
| body-sm | 13/20, 400 | tables, meta |
| caption | 12/16, 500 | labels, badges |
| mono-sm | 13/20 | UUID tails, amounts |

UUIDs are shown truncated (`…0042`) with click-to-copy. Money uses tabular numerals + currency
code from the resource (`SAR` default), right-aligned even in RTL.

## 4. Spacing & layout

- 4px base scale (`1=4px … 6=24px … 8=32px`). Page gutter `24px` desktop / `16px` mobile.
- **App shell:** fixed top bar (56px) + collapsible side nav (260px / 72px collapsed) +
  content. RTL flips nav to the right. Breakpoints: `sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`.
- **Content max-width** 1440px; financial/analytics pages go full-bleed for tables/charts.
- **Density toggle** (comfortable/compact) persisted in Zustand — clinics live in tables all day.

## 5. Tables (standard)

TanStack Table. Every list screen follows the same contract because the API does:

- **Toolbar:** left = search (`q`/`search`) + filter chips (status, branch, staff, customer,
  date range); right = column visibility, density, export (where `reports.export`), primary action.
- **Server-driven:** `page`/`limit` from the table → query params; render `total` for pagination.
  Default `limit` 20 (50 for messages/contacts/holidays/system-settings). Never client-paginate
  beyond the current page.
- **Columns:** id (mono, truncated) · primary entity (name + secondary line) · StatusBadge ·
  money (tabular, right) · relative time (hover = absolute, tooltip in clinic timezone) ·
  row actions (kebab, permission-filtered).
- **States:** sticky header; zebra off, hover highlight on; selected-row checkbox column only when
  a bulk action exists (campaign recipients remove, etc.).
- **Empty / loading / error** — see §10.
- **Sorting:** only where the API supports it (campaigns `sortBy`, calendar slots/api-logs `sort`).
  Otherwise columns are not sortable (don't fake it).

## 6. Forms (standard)

react-hook-form + zod, schemas mirrored 1:1 from DTO validators (lengths, enums, ranges below).

- Layout: single column ≤640px, two-column on `lg` for long forms. Labels above inputs.
- **Validation parity (from DTOs):** mirror `@MaxLength`, `@Min/@Max`, `@IsEnum`, `@Length(3,3)`
  (currency), `@IsISO8601`, `@IsEmail`, `@IsUUID`. E.g. appointment `notes ≤ 2000`,
  message `content ≤ 8000`, campaign `name 1..200`, staff `bookingBufferMinutes 0..240`,
  agent `temperature 0..2`, review `rating 1..5`.
- **Money inputs:** 2-decimal, positive, currency selector defaults from tenant settings.
- **Date/time:** all inputs emit ISO-8601 **with offset**; show the clinic/branch timezone label.
- **Idempotency:** payment create, send-template, etc. accept `idempotencyKey` — generate a UUID
  per submit and reuse on retry.
- **Submit:** disabled while pending; show field errors from 400 (`errorCode VALIDATION_ERROR`),
  banner for 409/422 (conflict/business-rule). Never silently swallow `requestId`.

## 7. Modals vs Drawers vs Pages — decision rules

| Use | Pattern |
|---|---|
| Quick create / single action with reason (cancel, reject, approve, reschedule, refund, assign) | **Modal** (focused, ≤2 fields + reason) |
| Inspect a record while keeping list context (appointment, payment, conversation, customer peek) | **Right Drawer** (480–560px; tabs inside) |
| Full edit / multi-section management (staff profile, campaign builder, agent config, tenant detail) | **Page** |
| Conversation thread | **Two-pane page** (list + thread), drawer for contact profile |

Drawer = read + light actions; Page = heavy editing. Modals always have an explicit
primary/destructive button and never more than one nested level.

## 8. Badge & chip system

- **StatusBadge** (§2) — filled soft (`bg-{token}/12 text-{token}-700`), 12px caption, dot for
  states needing extra emphasis (SUSPENDED, RUNNING pulse).
- **CountBadge** — unread conversations, pending handovers, failed recipients (danger if >0).
- **TagChip** — CRM customer tags (tenant-defined color), removable where `crm.tags.manage`.
- **RoleChip** — user roles in Users/Roles screens.
- **ChannelChip** — WHATSAPP / SMS / EMAIL / PUSH / IN_APP for notifications.

## 9. Permission-based UI rules

The single most important cross-cutting rule set. Backed by `GET /auth/me` (live roles+permissions
re-fetched each call).

1. **Hide, don't disable, navigation.** A menu item the user can't reach (no read permission) is
   removed (§01 menu table).
2. **Disable + tooltip in-context actions** the user could plausibly want but can't do
   (e.g. receptionist sees a payment row from a customer drawer but no "Refund"): show disabled with
   "Requires payments permission".
3. **`<Can permission="...">` gate** wraps every action button, bulk action, and form. Two forms:
   `requireAll` / `requireAny`.
4. **ABAC for customers:** customer views always send/expect own-records only; never render a
   global list for `customer`.
5. **ActiveTenant gate:** if `GET /tenants/me` shows `approvalStatus !== APPROVED || !isActive`,
   replace the whole workspace with an **"Account under review / suspended"** state (see onboarding
   flow) — because every tenant route will 403 anyway.
6. **Write-only secrets** (`accessToken` on WhatsApp account, API key value) are never displayed
   after creation — show "set"/"rotate", reveal once on create/rotate only.
7. **Optimistic vs confirm:** state transitions that the server may reject (appointment status
   machine, campaign launch, subscription change) are **not** optimistic — wait for 200 then
   reconcile.

## 10. Empty / Loading / Error (global contract)

- **Loading:** skeletons that match final layout (table rows, card grids, calendar). Never spinners
  for full pages. Inline button spinners for actions.
- **Empty:** illustration + one-line explanation + the primary create action (if permitted) +
  link to docs. Distinguish "no data yet" from "no results for these filters" (offer "clear
  filters").
- **Error:** card with `message`, a retry button, and a copyable `requestId`. 403 →
  "You don't have access" (no retry). 401 → silent refresh→retry, then redirect to login.
  409/422 → inline business-rule banner with the server `message` (these carry real meaning, e.g.
  "staff member is busy in the new window", "appointment is not completed yet").

## 11. Internationalization & timezone

- **RTL by default.** All layout uses logical properties (`ms-`, `me-`, `ps-`, `pe-`). Icons that
  imply direction mirror.
- Tenant `defaultLanguage` (`ar`) and `currency` (`SAR`) seed the UI; per-branch `timezone`
  governs calendar/scheduling rendering. Always render times in the relevant branch timezone and
  label it.
