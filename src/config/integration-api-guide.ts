/**
 * Partner-facing guide rendered as the description of the Integration API
 * document (`/docs/integrations`). Everything stated here is a fact about the
 * shipped behaviour — `integration-api-guide.spec.ts` pins the values that are
 * most likely to drift (limits, signature scheme, header names, event names) to
 * the constants the runtime actually reads, so a code change that invalidates
 * this text fails a test instead of silently misleading a partner.
 *
 * Written as a template literal: a literal backslash-n in a sample is spelled
 * `\\n` here, and backticks are escaped.
 */
import {
  ADMISSION_LIMITS,
  ADMISSION_OP,
  DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
  INBOUND_EVENTS,
  INBOUND_HEADER,
  INBOUND_REJECTION,
  INBOUND_EVENT_RETENTION_DAYS,
  WEBHOOK_MAX_TOLERANCE_SECONDS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '../modules/integration-platform/integration-platform.constants';
import { EXTERNAL_WRITABLE_FIELDS } from '../modules/integration-platform/write/source-of-truth';
import { DEFAULT_RATE_PER_MINUTE } from '../modules/platform/guards/api-key-auth.guard';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_HEADER,
} from '../modules/platform/webhook.constants';

/** Effective JSON body cap: the HTTP framework default (100 KB), enforced before any handler runs. */
export const INTEGRATION_MAX_BODY_BYTES = 100 * 1024;

const write = ADMISSION_LIMITS[ADMISSION_OP.WRITE];
const inbound = ADMISSION_LIMITS[ADMISSION_OP.INBOUND_WEBHOOK];
const unsigned = ADMISSION_LIMITS[ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED];
const fields = (resource: keyof typeof EXTERNAL_WRITABLE_FIELDS): string =>
  EXTERNAL_WRITABLE_FIELDS[resource].map((f) => `\`${f}\``).join(', ');

export const INTEGRATION_API_GUIDE = `
Connect an existing clinic system (PMS / EMR / booking tool) to Ziyarati:
**read** clinic data, **write** (upsert) records, **push** changes to us with
signed webhooks, and **receive** signed webhooks from us. Everything runs over
HTTPS + JSON. No database access and no internal knowledge is needed.

## Quick start

1. In the clinic dashboard open the **Developer** page. Create an **API key** with
   the scopes you need, and copy it — it is shown **once**.
2. Create a **Connection** for your system (this gives you a **Connection ID**).
3. Check the key works — no side effects:
   \`curl -H "X-API-Key: zk_..." https://<api-host>/api/v1/integrations/me\`
4. Read data (\`GET /integrations/services\`) and/or write it
   (\`POST /integrations/customers/upsert\`).
5. Optional: add an **inbound webhook endpoint** so your system can push events,
   and an **outbound webhook endpoint** so Ziyarati can notify you. Use
   "Send test event" to verify your receiver.

## Base URL, versioning, format

- Base URL: \`https://<api-host>/api/v1\` — the version is part of the path.
- Requests and responses are JSON, UTF-8 (\`Content-Type: application/json\`).
- Timestamps are ISO-8601 **with an explicit UTC offset** — \`2026-10-28T10:00:00Z\`
  or \`2026-10-28T13:00:00+03:00\`. A value without an offset, a date only, or a
  number is refused with \`400\`; the server never guesses a time zone. Platform ids
  are UUIDs; your own ids travel as \`externalId\` (max 255 characters).
- Send a correlation id with \`X-Request-Id\` (1–128 characters of \`A-Za-z0-9._:-\`)
  and it is echoed back; any other value is replaced by a generated one. Every
  response carries \`X-Request-Id\` — quote it to support. When the platform build
  is known, responses also carry \`X-App-Revision\` (the deployed commit id).
- Field naming is per resource and is **not** uniform: customers use
  \`snake_case\` (\`full_name\`), services / staff / appointments use
  \`camelCase\` (\`durationMinutes\`). Use the exact names listed below.

## Authentication and scopes

Send the key on every request as **either**
\`X-API-Key: zk_...\` **or** \`Authorization: ApiKey zk_...\`.
The clinic (tenant) is derived from the key alone — never send or trust a tenant
id. A key works only for the scopes it was created with; a missing scope is
\`403 FORBIDDEN\`. A missing, unknown, expired or revoked key is \`401 UNAUTHORIZED\`
with the same body in every case (the reason is deliberately not disclosed).

| Scope | Allows |
|---|---|
| \`integration.services.read\` / \`staff.read\` / \`availability.read\` / \`customers.read\` / \`appointments.read\` | the matching \`GET\` endpoints |
| \`integration.customers.write\` / \`services.write\` / \`staff.write\` / \`appointments.write\` | the matching \`POST .../upsert\` |
| any ONE of \`availability.read\`, \`appointments.read\`, \`appointments.write\` | \`GET /integrations/branches\` (branch discovery) |

- Use **one key per system**, the **fewest scopes**, and an **expiry date**.
- **Rotating** a key invalidates the old one immediately — deploy the new key first
  in your secret store, then rotate. Revoked keys stop working at once.
- \`GET /integrations/me\` returns \`{ keyId, keyPrefix, name, tenantName, scopes, expiresAt, lastUsedAt }\`
  and never the key itself. Needs no particular scope.

## Reading data

\`GET /integrations/{services|staff|customers|appointments|branches}\` (list) and
\`.../:id\` (one), plus \`GET /integrations/availability\`. **Branch ids:** availability
queries and appointment writes need a \`branchId\` — list your clinic's branches with
\`GET /integrations/branches\` (returns only \`id\`, \`name\`, \`timezone\`, \`isActive\`).
Lists take \`page\` (1-based) and
\`limit\` (max 100) and return \`{ data, total, page, limit }\`. Order is stable
across pages (ties are broken by id), so paging never repeats or skips a record.
An id that does not exist **or belongs to another clinic** is \`404\`.

## Writing data (upsert)

\`POST /integrations/{customers|services|staff|appointments}/upsert\`

\`\`\`json
{ "connectionId": "<uuid>", "externalId": "PMS-1042", "data": { "full_name": "Amal Khan", "phone": "+966500000001" } }
\`\`\`

The pair (connection, \`externalId\`) identifies the record, so repeating a call is
safe. Response \`200\`: \`{ outcome, externalId, internalId, changedFields? }\` where
\`outcome\` is \`created\`, \`updated\`, \`linked\` (matched an existing record and
mapped it), or \`skipped\` (nothing changed — an identical re-send is always
\`skipped\`). A payload the platform did **not** apply is never a \`200\`: it is
\`409 CONFLICT\` with \`context\` = \`{ outcome: "conflicted", reason, externalId,
internalId, changedFields }\` (see **Conflicts** below).

**Conflicts.** Each connection has a conflict policy for the case where the
platform record differs from what you send:

| Policy | Behaviour |
|---|---|
| \`reject_and_report\` (default) | Applies your update **only if nobody at the clinic has changed the record since your system last wrote it**. If the clinic edited it, nothing is applied, a review item is queued for the clinic and you get \`409\` with \`reason: "field_divergence"\`. A record that existed before your first write (no baseline yet) is also \`409\` until an identical re-send establishes one. |
| \`external_wins\` | Your values overwrite the platform's (allow-listed fields only). |
| \`platform_wins\` | The platform record is kept; the response is \`200\` \`skipped\`. |

Other \`reason\` values: \`staff_requires_account\` (an unmatched staff member is
queued for the clinic to review — an integration never creates a login),
\`lifecycle_not_allowed\`, \`missing_dependency\`. Retry a \`409\` conflict only after
the clinic has resolved it.

**Idempotency.** Send \`Idempotency-Key: <unique string>\` (1–255 printable ASCII characters, no spaces;
anything else is \`400\`) to make a retry return the original response. Keys live
24 hours from first use and are not honoured after that, even before our
clean-up job runs. Same key + same body = replay; same key + a different body =
\`422\`; same key while the first request is still running = \`409\`. A request
refused with \`409 conflicted\` releases its key.

**Writable fields (exact names):**

- customer: ${fields('customer')}
- service: ${fields('service')}
- staff: ${fields('staff')} — **update / link only**. Staff are never created
  through the API (a person needs a login account created by the clinic); an
  unmatched staff record is queued for the clinic to review.
- appointment: ${fields('appointment')} — plus the hints
  \`customerExternalId\`, \`staffExternalId\`, \`serviceExternalIds\`, \`action\`
  (\`"cancel"\` | \`"reschedule"\`) and \`reason\`. \`branchId\` is required (an
  internal id from \`GET /integrations/branches\` — branches have no external id).
  References must already be mapped (upsert the customer / staff / service
  first) or the call fails with \`422\` and \`context.reason = "missing_dependency"\`.
  \`startAt\` / \`endAt\` need an explicit offset and \`endAt\` must be after \`startAt\`.
  Re-sending an unchanged appointment is \`skipped\` (service ids compare as a
  set). Availability is re-checked inside a transaction, so a double-booking is
  refused (\`409\`), never created. \`action\` is honoured on this endpoint, which
  is gated by the \`appointments.write\` scope; **via inbound webhooks the
  lifecycle comes only from the event type** (below).

**Protected fields are rejected, not ignored.** Naming a platform-owned field
(ids, tenant, timestamps, \`status\`, \`currency\`, payment / settlement / fee
fields, roles, credentials, \`source\` on appointments…) returns \`422\` with
\`context.protectedFields\`. Unknown fields are ignored. When the clinic edited a
record too, the connection's conflict policy decides who wins.

## Limits

| What | Limit |
|---|---|
| Read requests | ${DEFAULT_RATE_PER_MINUTE} / minute / key by default (per-deployment setting) |
| Write requests | ${write.perKeyPerMin} / minute / key, ${write.perTenantPerMin} / minute / clinic |
| Inbound webhooks to us (signed) | ${inbound.perConnectionPerMin} / minute / connection, ${inbound.perTenantPerMin} / minute / clinic |
| Inbound deliveries that fail authentication | ${unsigned.perIpPerMin} / minute / source address, ${unsigned.perConnectionPerMin} / minute / connection — a **separate** budget, so unsigned traffic cannot block your signed events |
| Request body | ${INTEGRATION_MAX_BODY_BYTES / 1024} KB of JSON — larger returns \`413\` |
| Page size | 100 |
| Idempotency window | 24 hours |
| Inbound delivery history | ${INBOUND_EVENT_RETENTION_DAYS} days |

\`429 RATE_LIMITED\` carries a \`Retry-After\` header (seconds) — wait at least that
long. \`503 SERVICE_UNAVAILABLE\` means the platform could not safely admit the
request (nothing was written): retry with exponential backoff and jitter, and
reuse the same \`Idempotency-Key\`.

## Errors

Every error has the same shape; branch on \`code\`, log \`requestId\` and quote it
to support.

\`\`\`json
{ "statusCode": 422, "code": "UNPROCESSABLE_ENTITY", "message": "...", "path": "/api/v1/...", "timestamp": "...", "requestId": "..." }
\`\`\`

| HTTP | \`code\` | Meaning / what to do |
|---|---|---|
| 400 | \`VALIDATION_ERROR\` | Bad or missing field; \`message\` / \`context.fields\` say which. Do not retry unchanged. |
| 401 | \`UNAUTHORIZED\` | Key missing, invalid, expired or revoked — identical body in every case. |
| 403 | \`FORBIDDEN\` | The key lacks the scope for this endpoint, or the clinic account is suspended. |
| 404 | \`NOT_FOUND\` | Unknown id, or it belongs to another clinic. |
| 409 | \`CONFLICT\` | Same \`Idempotency-Key\` still in flight (retry shortly); **or** an upsert that was not applied because of a conflict (\`context.outcome = "conflicted"\`); **or** a forbidden lifecycle transition such as cancelling an already-cancelled appointment, or a slot that is already taken. |
| 413 | \`VALIDATION_ERROR\` | Body larger than ${INTEGRATION_MAX_BODY_BYTES / 1024} KB. |
| 422 | \`UNPROCESSABLE_ENTITY\` | Well-formed but refused: protected field, idempotency-key reuse with a different body, missing dependency, inactive connection. |
| 429 | \`RATE_LIMITED\` | Slow down; honour \`Retry-After\`. |
| 503 | \`SERVICE_UNAVAILABLE\` | Temporary; retry with backoff (nothing was written). |

Treat 5xx, 429 and network failures as retryable; 4xx (except 409 / 429) as
permanent until you change the request.

## Inbound webhooks — your system pushes events to Ziyarati

\`POST https://<api-host>/api/v1/integrations/inbound/{connectionId}\` — no API key;
the request is authenticated by an HMAC signature made with the endpoint's
**signing secret** (shown once when the endpoint is created).

Headers (all required under the default scheme):

| Header | Value |
|---|---|
| \`${INBOUND_HEADER.SIGNATURE}\` | \`sha256=<hex HMAC-SHA256>\` |
| \`${INBOUND_HEADER.TIMESTAMP}\` | Unix time in **seconds**; must be within ±${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} s of our clock (endpoint-configurable, max ${WEBHOOK_MAX_TOLERANCE_SECONDS} s) |
| \`${INBOUND_HEADER.EVENT_ID}\` | Unique id of this event (your id; the replay guard) |
| \`${INBOUND_HEADER.EVENT_TYPE}\` | One of: ${INBOUND_EVENTS.map((e) => `\`${e}\``).join(', ')} (and enabled on the endpoint) |

Body: \`{ "externalId": "...", "data": { ...writable fields... } }\`. If the body
also carries \`eventId\` / \`event\`, they must equal the headers.

**Signing string (scheme \`${DEFAULT_WEBHOOK_SIGNATURE_SCHEME}\`, the default).** Join four
parts with a newline character (LF, a real newline — HTTP headers cannot contain
one, so the parts cannot be re-split): \`timestamp\\neventId\\neventType\\nrawBody\`. Sign
the **exact bytes you send** as the body.

\`\`\`js
const crypto = require("crypto");
const body = JSON.stringify({ externalId: "PMS-1042", data: { full_name: "Amal Khan", phone: "+966500000001" } });
const ts = String(Math.floor(Date.now() / 1000));
const eventId = crypto.randomUUID();
const eventType = "customer.upserted";
const mac = crypto.createHmac("sha256", SIGNING_SECRET)
  .update(ts + "\\n" + eventId + "\\n" + eventType + "\\n" + body).digest("hex");
// send: X-Ziyarati-Signature: sha256=<mac>, X-Ziyarati-Timestamp: ts,
//       X-Ziyarati-Event-Id: eventId, X-Ziyarati-Event: eventType
\`\`\`

Older endpoints may use the legacy schemes \`hmac_sha256_timestamped\`
(\`timestamp.rawBody\`) or \`hmac_sha256_body\` (body only). They still work but are
**deprecated**: they do not sign the event id/type, so a captured request can be
replayed under a new id (\`hmac_sha256_body\` has no timestamp at all). The
dashboard flags them. Moving an endpoint **up** to the default scheme is allowed
at any time; moving a default-scheme endpoint **back** to a legacy scheme is
refused (\`400\`) — create a new endpoint if you truly must. Plan to migrate: rotate
the secret and switch your signer in the same maintenance window.

**What an event may do is decided by its type only.** \`appointment.created\`
creates; \`appointment.rescheduled\` moves; \`appointment.cancelled\` cancels — and
each must be enabled on the endpoint, checked again when the event is applied.
An \`action\` field inside \`data\` is ignored. A \`created\` event for an appointment
that already exists never changes it (identical = no-op, otherwise a review item
is queued); \`rescheduled\` / \`cancelled\` for an unknown external id is refused
rather than creating anything.

**Responses**

| HTTP | Meaning |
|---|---|
| 202 | Accepted and queued: \`{ received, eventId, status: "accepted" }\`. Processing is asynchronous. |
| 200 | Duplicate of an event id we already have — a safe acknowledgement, do not resend. |
| 403 | Signature, timestamp or replay check failed (\`context.reason\`, e.g. \`invalid_signature\`, \`stale_timestamp\`, \`missing_event_id\`). |
| 429 | Over the signed-event budget, or (for failed-authentication traffic) its separate budget; honour \`Retry-After\`. |
| 422 | Authenticated but refused; \`context.reason\` is one of ${[
  INBOUND_REJECTION.EVENT_NOT_ALLOWED,
  INBOUND_REJECTION.UNSUPPORTED_EVENT,
  INBOUND_REJECTION.MISSING_EXTERNAL_ID,
  INBOUND_REJECTION.PROTECTED_FIELDS,
  INBOUND_REJECTION.MALFORMED,
  INBOUND_REJECTION.HEADER_BODY_MISMATCH,
  INBOUND_REJECTION.CONNECTION_INACTIVE,
]
  .map((r) => `\`${r}\``)
  .join(', ')}. |

A rejected event **keeps its event id**. After fixing the cause, send it again
under a **new** event id — re-sending the same id is answered \`200\` (duplicate),
which is deliberate: it is the replay protection, and it also means a corrected
payload is never applied under an id we already hold. Delivery history and
rejection reasons are visible to the clinic in the dashboard.
\`POST .../inbound/{connectionId}/ping\` is an unauthenticated reachability probe:
it only echoes the id you sent, discloses nothing about the connection or its
configuration, and does not prove the signing secret is right (send a signed
event for that).

## Outbound webhooks — Ziyarati notifies your system

Register an **HTTPS** receiver in the dashboard — plain \`http://\` is refused in
production at registration and again before every delivery (private, loopback,
cloud-metadata and IPv6 transition-mechanism addresses such as NAT64 / 6to4 are
refused too; redirects are never followed). Subscribe to any of:
${WEBHOOK_EVENTS.map((e) => `\`${e}\``).join(', ')}. Payloads contain ids and
scalar values only (fetch details with the read API). The event name is in the
\`${WEBHOOK_HEADER.EVENT}\` header; the body is the event data itself.

Every delivery carries: \`${WEBHOOK_HEADER.ID}\` (identifies this delivery; stable
across automatic retries), \`${WEBHOOK_HEADER.ORIGINAL_ID}\` (identifies the
**event**: equal on retries **and** on every manual replay),
\`${WEBHOOK_HEADER.EVENT}\`, \`${WEBHOOK_HEADER.TIMESTAMP}\` (Unix seconds),
\`${WEBHOOK_HEADER.SIGNATURE}\` = \`sha256=\` + hex HMAC-SHA256 of
\`timestamp + "." + rawBody\` using the endpoint's secret (\`whsec_...\`), and
\`${WEBHOOK_HEADER.SIGNATURE_V2}\` = \`sha256=\` + hex HMAC-SHA256 of
\`timestamp + "\\n" + deliveryId + "\\n" + eventType + "\\n" + rawBody\`, which also
authenticates the id and event headers. **Prefer verifying V2**; the original
header is unchanged for existing receivers.

\`\`\`js
function verify(rawBody, headers, secret) {
  const ts = headers["x-webhook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject stale
  const expected = "sha256=" + require("crypto").createHmac("sha256", secret)
    .update(ts + "." + rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(headers["x-webhook-signature"] || "");
  return a.length === b.length && require("crypto").timingSafeEqual(a, b);
}
\`\`\`

- Verify against the **raw** body bytes, in constant time.
- Answer with a **2xx quickly** (10 s timeout) and do the work afterwards.
- Delivery is **at-least-once**: **deduplicate on \`${WEBHOOK_HEADER.ORIGINAL_ID}\`**
  (use \`${WEBHOOK_HEADER.ID}\` only to tell deliveries apart). A manual replay is a
  new delivery with a new id but the same original id.
  There is **no ordering guarantee** — use the timestamps / re-read the record.
- A delivery is bound to the URL it was queued for. If you edit the endpoint URL,
  deliveries already queued fail permanently (\`endpoint_url_changed\`) instead of
  going to the new address — replay them from the dashboard to deliver to the new
  URL.
- \`408\`, \`425\`, \`429\`, \`5xx\`, timeouts and network errors are retried (up to 6
  attempts, exponential backoff from 5 s). Any other \`4xx\`, and any \`3xx\`, is
  permanent. Failed deliveries can be replayed from the dashboard.
- "Send test event" delivers a synthetic \`webhook.test\` to verify your receiver
  (5 per minute per endpoint). It is never a subscribable event.
- Rotating the secret takes effect immediately; update your receiver first.

## Production checklist

Keep keys and secrets in a secrets manager (never in source control, chat or logs);
one key per system; least-privilege scopes; set an expiry and rotate when staff
leave; alert on sustained 401/403/429; deduplicate webhooks; monitor your receiver.

## Not supported (do not build against these)

Bulk import through an API key, lookup by \`externalId\`, customer / service change
events, hard deletes, IP allow-lists, OAuth client-credentials for partners, a
sandbox clinic, key-rotation grace periods, ordered event delivery, and
one-key-per-connection binding (a key with a write scope may write through any
active connection of its clinic).
`.trim();
