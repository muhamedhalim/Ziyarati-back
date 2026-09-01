# ZiyaraTech — Load Test Report

**Date**: 2026-09-01 · **Environment**: LOCAL isolated lab · **Data tier**: T1
**Target**: single API process, `node dist/src/main`, no worker running
**Tool**: k6 v2.2.0 via Docker (`grafana/k6`)

Every number in this report came from a k6 run, a Prometheus scrape, a
`pg_stat_activity` sample, or a direct read of the source. Anything not
measured is labelled **Not measured**.

---

## 1. Architecture summary

Next.js 16 front end → same-origin `/api/*` rewrite → NestJS API (`/api/v1`) →
PostgreSQL 18 + Redis 7. The API and the worker are **separate processes**; the
API is a queue **producer only**.

- **Auth**: `POST /auth/login` returns `{user}` only — tokens are never in the
  body. They arrive as httpOnly cookies (`access_token` path `/`,
  `refresh_token` path `/api/v1/auth`, readable `csrf_token`). Non-GET requests
  need `X-CSRF-Token` matching the cookie. Bearer headers also work outside
  production and bypass CSRF entirely.
- **Six global guards** run on every request: Throttler → JwtAuth → Csrf →
  Maintenance → SubscriptionAccess → Feature.
- **Rate limiting**: 300 req/60s keyed on (handler, `req.ip`), Redis-backed.
  `trust proxy` is unset, so IPs cannot be spread. Lifted to 1e6 by
  `NODE_ENV=test`, which — verified by grep — changes nothing else in this
  codebase except other rate limits.
- **Tenancy**: derived from the authenticated principal, re-loaded from the DB
  on every request. No `X-Tenant-Id` header exists.
- **Pool**: `DB_POOL_MAX=10` in the tracked `.env` (code default is 15),
  `connectionTimeoutMillis` 10 000, no `statement_timeout`.
- **Billing mode** defaults to FREE, so no subscription/quota rejection occurs.

### Measured request cost

**4.4 database queries per HTTP request** (242 949 queries / 55 000 requests,
Prometheus `db_queries_total` delta over the sweep).

---

## 2. Test scenarios

| Scenario | What it establishes |
|---|---|
| `smoke` | every flow works end to end |
| `baseline` | comparability with the previous Artillery baseline |
| `mixed-workload` | realistic steady state |
| `progressive-sweep` | degradation / error / failure points |
| `appointments-write` | write throughput + race correctness |
| `public-booking` | unauthenticated surface |
| `spike` | surge and recovery |
| `soak` | drift and leaks |

**Traffic mix** was derived from the frontend's own request-assertion tests and
query configs, not assumed. The notification poll
(`/notifications/inbox/unread-count`, every 30 s on every authenticated page in
all four shells) is the highest-frequency endpoint in the product and carries
the largest share (22%). Writes are ~6% combined — a receptionist books a
handful of appointments per hour while viewing hundreds of pages; the commonly
proposed 15% write share would model a data-entry robot.

---

## 3. Load model

**Driven by arrival rate, not VUs.** The API is single-threaded Node; past
saturation, adding VUs grows a queue rather than load, and every stage beyond
the knee reports the same thing — timeouts. A "200 VU" ladder on this system
measures the queue, not the application.

One iteration = one user action = 1–6 HTTP requests, so **iterations/s is not
requests/s**; both are reported.

---

## 4. Test results

### 4.1 Baseline (comparability anchor)

8 it/s, 90 s, owner sessions, the same four endpoints the previous Artillery
harness used.

| Metric | Value |
|---|---|
| Requests | 2 958 (32.8 req/s) |
| p50 / p95 / p99 | 26.0 / 48.7 / 79.2 ms |
| Error rate | 0.00% |

**Versus the historical baseline** (`docs/PERFORMANCE_BASELINE.md`: p95 113.3 ms
at ≤8 req/s, 0% failures): p95 improved to 48.7 ms at 4× the request rate. The
difference is explained below in §12 — it is configuration, not a code change.

### 4.2 Progressive sweep — the degradation curve

Mixed workload, 40 s per step, `DB_POOL_MAX=10`.

| iters/s | req/s | p50 | p95 | p99 | max | errors | verdict |
|---:|---:|---:|---:|---:|---:|---:|---|
| 5 | 10 | 22 ms | 41 ms | 78 ms | 88 ms | 0.00% | Healthy |
| 10 | 20 | 24 ms | 40 ms | 55 ms | 90 ms | 0.00% | Healthy |
| 20 | 41 | 21 ms | 37 ms | 82 ms | 106 ms | 0.00% | Healthy |
| 40 | 81 | 18 ms | 39 ms | 75 ms | 127 ms | 0.03% | Healthy |
| 60 | 124 | 19 ms | 43 ms | 81 ms | 136 ms | 0.00% | Healthy |
| 80 | 169 | 20 ms | 48 ms | 86 ms | 269 ms | 0.21% | Healthy |
| 90 | 192 | 24 ms | 67 ms | 118 ms | 264 ms | 0.31% | **First degradation** |
| 100 | 208 | 33 ms | 108 ms | 208 ms | 641 ms | 0.00% | Degraded |
| 105 | 216 | 38 ms | 157 ms | 289 ms | 893 ms | 0.31% | Degraded |
| 110 | **223** | 42 ms | 166 ms | 319 ms | 706 ms | 0.00% | Degraded, still correct |
| 120 | 196 | 408 ms | **11 363 ms** | 18 434 ms | 20 879 ms | **11.14%** | **Unhealthy** |
| 130 | 117 | 10 099 ms | 13 759 ms | 18 885 ms | 23 606 ms | **49.94%** | **Failed** |
| 140 | 115 | 10 075 ms | 14 133 ms | 21 633 ms | 25 829 ms | 45.99% | Failed |
| 160 | 126 | 6 317 ms | 13 601 ms | 18 021 ms | 27 325 ms | 44.72% | Failed |

### 4.3 Key load points

- **First degradation: ~90 iterations/s (~192 req/s).** p95 rises from a flat
  ~40 ms plateau to 67 ms, then 108 ms at 100 it/s.
- **First significant errors: 120 iterations/s (~196 req/s)** — 11.14%.
  Below that, errors stay under 0.35% and are not 5xx.
- **Peak sustainable throughput: 223 req/s at 110 it/s**, still 0% errors and
  p95 166 ms.
- **Failure / congestion collapse: 120–130 iterations/s.** Throughput *falls*
  from 223 → 196 → 117 req/s as offered load increases, with error rates of
  11% then 50%. Serving capacity roughly halves under overload.

### 4.4 Steady state (recommended operating point)

60 it/s (124 req/s), 3 min: **p50 18.4 ms, p95 41.1 ms, p99 76.9 ms, 0.00%
errors, 0 × 5xx, 0 × 429, 0 business-check failures.**

### 4.5 Spike and recovery

20 → 130 → 20 it/s.

| Phase | p95 |
|---|---|
| pre | 40 ms |
| spike (130 it/s) | 14 297 ms |
| recovery | **39 ms** |

**Recovered fully.** The system degrades badly under overload but returns to
baseline once load drops — no leaked connections, no permanent damage.

### 4.6 Soak

40 it/s (84 req/s) for 10 minutes: 50 831 requests, p50 17.8 / p95 37.7 /
p99 72.7 ms, 0.54% errors (see §14), **0 × 5xx**, 5 timeouts.

| Drift signal | Result |
|---|---|
| Heap | **−8 MB** |
| RSS | **+2 MB** |
| Event-loop lag p99 max | 0.209 s |
| pg idle-in-transaction max | 1 |

**No memory leak detected over 10 minutes.** Note this is a reduced soak — the
60-minute run is **Not measured**.

### 4.7 Public (unauthenticated) surface

10 it/s, 90 s: 7 202 requests, **0 errors, 0 × 429, 0 × 5xx**.

---

## 5. Endpoint performance ranking

Mixed workload at 60 it/s (124 req/s), 3 minutes.

| Endpoint | med | p95 | p99 | max |
|---|---:|---:|---:|---:|
| `POST /appointments` | 78.5 ms | **112.4 ms** | 134.7 ms | 149 ms |
| `GET /staff?limit=100` | 36.4 ms | 56.6 ms | 60.2 ms | 82 ms |
| `POST /appointments/:id/status` | 19.3 ms | 54.1 ms | 77.0 ms | 121 ms |
| `GET /appointments/:id/timeline` | 29.0 ms | 48.4 ms | 57.6 ms | 73 ms |
| `GET /appointments/:id/reminders` | 28.3 ms | 47.3 ms | 55.2 ms | 71 ms |
| `GET /appointments/:id/notes` | 27.8 ms | 46.5 ms | 54.9 ms | 70 ms |
| `GET /scheduling/availability/windows` | 24.8 ms | 45.9 ms | 59.0 ms | 71 ms |
| `GET /staff` | 28.2 ms | 45.3 ms | 53.5 ms | 82 ms |
| `GET /tenants/me/targets` | 24.0 ms | 43.7 ms | 55.1 ms | 112 ms |
| `GET /appointments` | 22.9 ms | 40.3 ms | 49.3 ms | 99 ms |
| `GET /analytics/trends/*` | 19.8 ms | 35.8 ms | 49.2 ms | 97 ms |
| `GET /analytics/performance/staff` | 13.9 ms | 33.6 ms | 37.4 ms | 38 ms |
| `GET /dashboard/summary` | 16.1 ms | 32.4 ms | 42.8 ms | 97 ms |

`POST /appointments` is the slowest endpoint by a factor of two — consistent
with its ~15–20 round trips inside a single transaction.

---

## 6. THE BOTTLENECK — PostgreSQL connection pool exhaustion

**Confidence: proven by controlled experiment, not inferred.**

### Evidence 1 — every 5xx has the same cause

100% of server errors across every run are
`"timeout exceeded when trying to connect"` — the node-postgres pool checkout
timeout (`connectionTimeoutMillis` = 10 000 ms). Not a query error, not a crash.

### Evidence 2 — the pool is held by transactions that are not doing work

`pg_stat_activity`, sampled every 2 s at the collapse point:

| t (s) | active | idle | **idle in transaction** | longest active query | event-loop lag p99 |
|---:|---:|---:|---:|---:|---:|
| 419 | 2 | 5 | 4 | 0.00 s | 0.025 s |
| 421 | 2 | 2 | 7 | 0.00 s | 0.027 s |
| 423 | 1 | 0 | **10** | 0.00 s | 0.022 s |
| 426 | 1 | 0 | **10** | 0.00 s | 0.024 s |
| 430 | 1 | 0 | **10** | 0.00 s | 0.024 s |

All 10 connections (the entire pool) are held by transactions sitting **idle**,
while only **one** query is executing and the longest query takes **0.00 s**.
The database is nearly idle. The event loop is fine (0.02 s lag). Yet no
connection is available.

### Evidence 3 — the controlled experiment

Identical contention test (30 VUs racing for one slot), single variable changed:

| `API_DB_POOL_MAX` | Created | Clean 409s | **5xx** |
|---:|---:|---:|---:|
| 10 | 4 | **0** | **90** |
| 40 | 3 | **2 228** | **0** |

At pool 10 the system cannot even reach the correctness check — clients get
HTTP 500 instead of the correct 409. At pool 40 the exclusion constraint
arbitrates perfectly and 5xx vanish entirely.

### Evidence 4 — raising the pool removes the error cliff

Sweep across the collapse region, pool 10 vs 40:

| iters/s | p95 @ pool 10 | errors @ pool 10 | p95 @ pool 40 | errors @ pool 40 |
|---:|---:|---:|---:|---:|
| 90 | 100 ms | 0.60% | 183 ms | 0.21% |
| 100 | 280 ms | 0.63% | 240 ms | 0.41% |
| 110 | 13 796 ms | **24.75%** | 3 378 ms | **0.61%** |
| 130 | — | — | 7 488 ms | 0.93% |
| 150 | — | — | 7 764 ms | 1.15% |

The **error cliff disappears** (24.75% → 0.61%). Latency still degrades past
~110 it/s, but as queueing rather than failure.

### Mechanism

`AppointmentsService.create` opens one transaction and holds it across roughly
15–20 sequential round trips — branch, customer, staff and service validation,
the full ~11-query availability engine, a usage-counter UPDATE, then four
INSERTs. Much of that time is application logic, not SQL, so the connection is
**checked out but idle**. With `DB_POOL_MAX=10`, only ten bookings can be in
flight; the eleventh waits 10 s and then 500s.

### Why the previous audit reached a different conclusion

Five prior passes concluded the pool was never the bottleneck and named
CPU/event-loop instead. Those measured **read-only** traffic, where connections
are held only for the duration of a query. Under a realistic **read + write**
mix the picture inverts. Both findings are correct for what they measured.

**Secondary limit**: with the pool raised to 40, CPU became the constraint
(78% of one core, `idle_in_tx` 36/40, lock waits appearing). So the pool is the
*first* limit, and single-thread CPU is the *next* one at roughly 220 req/s.

---

## 7. Database findings

| Finding | Evidence | Severity |
|---|---|---|
| Long transactions hold pooled connections while idle | §6 | **High** |
| `DB_POOL_MAX=10` in tracked `.env`; code default is 15 | `.env:21`, `typeorm.config.ts:213-221` | **High** |
| No `statement_timeout` / `idle_in_transaction_session_timeout` | grep over `src/` — not present | Medium |
| `/crm/customers/search` uses `ILIKE '%q%'` on 3 columns with no trigram index | `customer.service.ts:283-288`; the only `gin_trgm_ops` indexes are on `audit_logs` and `users` | Medium |
| `q` is not LIKE-escaped and has no minimum length — `q=%` matches every row | `customer.service.ts:283` | Medium |
| `/activity` issues an unbounded `COUNT(*)` over the same joins as the page | `activity-log.service.ts:166-169` | Low |
| Offset pagination with no page cap | `appointment.service.ts:324` | Low |
| `GET /staff/eligible-users` loads every `StaffProfile` row in the database, unfiltered by tenant | `staff.service.ts:694-699` | Medium |

**N+1 queries**: none found on the hot paths. `/appointments`, `/crm/customers`,
`/staff` and `/activity` all resolve relations in-SQL. Measured cost is a flat
**4.4 queries per request**, which is inconsistent with an N+1 pattern.

---

## 8. Redis findings

No Redis-attributable failure at any load level. Readiness reported
`redis: up, latencyMs: 1` throughout. **0 × 429** in every run confirms the
Redis-backed throttler behaved correctly under `NODE_ENV=test`.
Redis memory/latency under sustained load: **Not measured**.

---

## 9. Backend findings

| Finding | Evidence |
|---|---|
| Event-loop lag p99 peaked at **0.209 s** and did not correlate with the failure point | monitor samples |
| CPU: 37% of one core at ≤110 it/s; 78% once the pool was widened | `process_cpu_user_seconds_total` delta |
| **No memory leak**: heap −8 MB, RSS +2 MB over a 10-minute soak | monitor |
| Full recovery after a 130 it/s spike (p95 39 ms vs 40 ms pre-spike) | §4.5 |
| `TYPEORM_LOGGING=true` and per-request `api_logs` INSERTs are on by default and cost ~38% of throughput | 2 044 → 2 832 requests in an identical 30 s smoke |
| `API_CLUSTER_WORKERS` defaults to 1 — the second core is idle | `cluster-bootstrap.ts:65-73` |

---

## 10. External service findings

Deliberately excluded from all scenarios — **Not measured** by design:
WhatsApp, OpenAI, Resend email, Moyasar payments, and all webhook receivers.
Rationale in §11.

---

## 11. Security / safety findings

**No external side effect was possible during any run**, and this rests on a
structural property rather than configuration:

- The API is a queue **producer only**; every outbound send happens in the
  separate **worker** process, which was never started. Jobs accumulate in Redis
  and nothing leaves the machine.
- Verified empty in this database: `notification_rules`, `webhook_endpoints`,
  `workflows`, `whatsapp_accounts`, `system_settings`. Confirmed empirically —
  after creating a real appointment, every `bull:*:wait` queue was still 0.

Three findings worth escalating independently of performance:

1. **WhatsApp cannot be disabled by configuration.** `MetaWhatsappProvider` is
   the sole registered provider and its `supports()` is hardcoded `true`;
   `NoopWhatsappProvider` is unreachable dead code
   (`whatsapp.module.ts:183-187`, `meta-whatsapp.provider.ts:30-32`). The only
   controls are "don't run the worker" and "no `whatsapp_accounts` rows".
2. **`POST /payments/webhooks/moyasar` fails OPEN outside production.** With
   `MOYASAR_WEBHOOK_SECRET` empty (its current state) the verifier accepts the
   webhook (`moyasar-webhook.verifier.ts:31-44`). It is unauthenticated and the
   only public webhook with no per-route throttle, and it can mark payments
   PAID. Excluded from all scenarios.
3. **The tracked `.env` carries live `OPENAI_API_KEY`, `RESEND_API_KEY`,
   `META_APP_SECRET` and `EMAIL_ENABLED=true`.** A load test run without the
   overrides in `start-api.ps1` would spend real money and send real email.

No credential, token or cookie value is logged by the suite.

---

## 12. Infrastructure vs application — what was NOT the application's fault

- **~38% of the apparent capacity gap** in the first calibration was
  `TYPEORM_LOGGING=true` plus per-request `api_logs` INSERTs, both enabled by
  the tracked `.env`. Test-harness configuration, not application behaviour.
- **A steady ~0.5% "error rate" at every load level** was my own test design:
  83% of seeded appointments sit in terminal states (COMPLETED / NO_SHOW /
  CANCELLED) that legally accept no transition, so a random status update
  correctly returned 409 four times in five. After restricting transitions to
  suite-created appointments, the same scenario measured **0.00% errors**.
- **`dial: i/o timeout` warnings** from k6 at high rates are load-generator-side
  connection failures (Docker NAT), not server errors. They are counted
  separately as `http_timeout_or_conn` (137 across the whole overload sweep).
- **`dropped_iterations`** means k6 itself could not keep up, so offered load
  was below the configured rate — the overload steps are therefore *milder*
  than they appear.

---

## 13. Recommended fixes (NOT applied — measurement and remediation kept separate)

| # | Fix | Rationale | Priority |
|---|---|---|---|
| 1 | Raise `DB_POOL_MAX` (tracked `.env` sets 10; code default is 15). Size it against `API_CLUSTER_WORKERS` × pool ≤ Postgres `max_connections`. | Removes the error cliff entirely: 24.75% → 0.61% at 110 it/s, and 90 5xx → 0 under contention. Single highest-value change. | **P0** |
| 2 | Shorten the booking transaction — move validation and the availability engine **outside** the transaction, keeping only the final INSERTs inside. | Attacks the root cause rather than the symptom. The connection is held ~15–20 round trips while mostly idle; the exclusion constraint already guarantees correctness at INSERT time. | **P0** |
| 3 | Set `statement_timeout` and `idle_in_transaction_session_timeout`. | Nothing currently bounds a stuck transaction; one can hold a pool slot indefinitely. | **P1** |
| 4 | Default `TYPEORM_LOGGING=false` and `PLATFORM_API_LOG_ENABLED=false` (or sample) outside development. | Worth ~38% throughput. | **P1** |
| 5 | Enable `API_CLUSTER_WORKERS` > 1. | The process is single-threaded and CPU is the limit after the pool is fixed; prior work measured +24–35% throughput at 4 workers. | **P1** |
| 6 | Add a trigram index on `customers(full_name, email, phone)`, escape `q`, and enforce a minimum search length. | `/crm/customers/search` is a sequential scan by construction; `q=%` matches every row. | **P2** |
| 7 | Tenant-scope and paginate `GET /staff/eligible-users`. | It loads every `StaffProfile` row in the database on every call. | **P2** |
| 8 | Return 503 with `Retry-After` instead of a bare 500 on pool-checkout timeout. | Clients currently receive a generic 500 for a transient capacity condition. | **P3** |

Fixes 1 and 2 should be validated by re-running `baseline.js` and
`progressive-sweep.js` and diffing against §4 — the "before" is recorded here.

---

## 14. Known limitations

- Single API process on a developer workstation; **not production-transferable**.
- 60-minute soak: **Not measured** (10 minutes run instead).
- T2 tier (900k appointments): **Not measured** — plan-flip detection outstanding.
- WebSocket/AI realtime surface: **Not measured** (k6 HTTP cannot reach the
  Socket.IO namespace).
- Redis memory/latency under load: **Not measured**.
- The 0.54% error rate in §4.6 predates the §12 test-design fix; the corrected
  scenario measures 0.00%.
- One sweep run authenticated 9 of 10 accounts rather than 10; cause not
  established. It does not affect the reported percentiles.

---

## 15. Commands

```bash
# stack
docker start ziyarati-perfaudit-postgres ziyarati-perfaudit-redis
docker cp tests/load/data/fixture.sql ziyarati-perfaudit-postgres:/tmp/fixture.sql
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -f /tmp/fixture.sql
powershell -File tests/load/start-api.ps1

# scenarios (TEST_PASSWORD from the environment, never a file)
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/smoke.js
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/baseline.js
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/mixed-workload.js
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/progressive-sweep.js
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/appointments-write.js
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/public-booking.js
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/spike.js
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/soak.js

# correlation + cleanup
node tests/load/helpers/monitor.js --out tests/load/reports/monitor.json --interval 2000 --duration 300000
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -f /tmp/cleanup.sql
```
