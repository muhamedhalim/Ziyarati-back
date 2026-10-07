# ZiyaraTech k6 Load Test Suite

> **2026-10 update — the 20K campaign.** The post-feature 20,000-VU campaign (Tap payments, queue,
> marketplace, partner API, auth herd, worker/outbox, multi-generator runs, target guard) lives in
> [`lab/README.md`](lab/README.md) and is started ONLY through `lab/run-campaign.mjs`. The September
> scenarios below are kept as the regression baseline and now also pass through the target guard
> (`helpers/guard.js`). Where this file and `lab/README.md` disagree — payments are Tap;
> the lab uses its own pgvector Postgres/Redis and a sanitized environment — `lab/README.md` is current.

Runs entirely from Docker. Nothing is installed on the host.

```
tests/load/
  config/thresholds.js      per-endpoint-class SLOs + reporting sub-metrics
  helpers/auth.js           login once, cookie/CSRF handling, tenant context
  helpers/checks.js         business-behaviour assertions (not just HTTP 200)
  helpers/metrics.js        tagged custom metrics
  helpers/monitor.js        samples /metrics + pg_stat_activity during a run
  flows/                    per-domain request flows, mirroring the real UI
  scenarios/                the runnable tests
  data/fixture.sql          closes the perf-seed data gaps
  data/cleanup.sql          removes only rows the suite created
  reports/                  JSON output + api logs
  start-api.ps1             starts the API configured for load testing
```

## 1. Prerequisites

```bash
docker start ziyarati-perfaudit-postgres ziyarati-perfaudit-redis
```

Apply the fixture once (idempotent):

```bash
docker cp tests/load/data/fixture.sql ziyarati-perfaudit-postgres:/tmp/fixture.sql
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -f /tmp/fixture.sql
```

Start the API with load-test configuration:

```bash
powershell -File tests/load/start-api.ps1
```

**Do not start the worker.** That is the primary safety control — see §5.

## 2. Running

`TEST_PASSWORD` must be in the host environment; it is never stored in a file.

```bash
TEST_PASSWORD='...' docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/smoke.js
```

| Scenario | Purpose | Typical invocation |
|---|---|---|
| `smoke.js` | proves every flow works | `DURATION=1m` |
| `baseline.js` | comparability anchor (mirrors the old Artillery journey) | `RATE=8 DURATION=5m` |
| `mixed-workload.js` | realistic steady state | `RATE=60 DURATION=5m` |
| `progressive-sweep.js` | finds the degradation / failure points | `RATES=5,10,20,40,60,80,100,110` |
| `appointments-write.js` | write throughput + race correctness | `RATE=12 CONTEND_VUS=8` |
| `public-booking.js` | unauthenticated surface | `RATE=10` |
| `spike.js` | surge and, crucially, recovery | `RATE=20 PEAK_RATE=130` |
| `soak.js` | drift / leak detection | `RATE=40 DURATION=60m SOAK_RELOGIN=true` |

Correlate with backend internals (run alongside any scenario):

```bash
node tests/load/helpers/monitor.js --out tests/load/reports/monitor.json --interval 2000 --duration 300000
```

After any write scenario, restore the dataset:

```bash
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -f /tmp/cleanup.sql
```

## 3. Why arrival rate, not VUs

The API is single-threaded Node. Past saturation, adding VUs does not add load —
it grows a queue, and every stage beyond the knee reports the same thing:
timeouts. `constant-arrival-rate` holds offered load fixed so the per-step
numbers stay comparable. A "200 VU" stage on this system measures the queue,
not the application.

One iteration is one user action (1–6 HTTP requests), so **iterations/s is not
requests/s** — the sweep report records both.

## 4. Things that will silently invalidate a run

- **The rate limiter.** 300 req/60s, keyed on (handler, `req.ip`), Redis-backed.
  `trust proxy` is unset, so per-VU IPs cannot spread the bucket, and every VU on
  one load generator shares it. `start-api.ps1` sets `NODE_ENV=test`, which
  raises it to 1e6 and — verified by grep — changes nothing else in this
  codebase except other rate limits.
- **Login lockout is never relaxed**: 5 failed attempts per email per 900s.
  Never point this suite at an account with a wrong password.
- **`TYPEORM_LOGGING` and `PLATFORM_API_LOG_ENABLED`** default to on via the
  tracked `.env`. Leaving them on cost ~38% of throughput in measurement.
- **Docker networking**: `localhost` inside the container is the container.
  Use `host.docker.internal`.
- **Git Bash path mangling**: prefix docker commands with `MSYS_NO_PATHCONV=1`
  or in-container paths get rewritten to Windows paths.
- **k6 sub-metrics only exist if a threshold references them.** The endpoint
  ranking is built from `endpoint_latency{endpoint:*}` thresholds declared in
  `config/thresholds.js`; an endpoint missing from `ENDPOINTS` there will be
  silently absent from every report.
- **k6 Trend metrics have no `count` field** — filter on `max` instead.
- **docker-compose does not forward arbitrary host env.** Every scenario knob
  must be listed in `docker-compose.yml`, or it is silently ignored and the
  default runs instead.

## 5. Safety

The suite performs real writes. It is safe here because of a **structural**
property, not configuration:

- The API process is a queue **producer only**. Every outbound send — WhatsApp,
  email, webhooks, workflow actions — happens in the separate **worker**
  process. With no worker running, jobs accumulate in Redis and nothing leaves
  the machine.
- **WhatsApp cannot be disabled by any environment variable.**
  `MetaWhatsappProvider` is the sole registered provider and its `supports()` is
  hardcoded `true`; `NoopWhatsappProvider` is unreachable dead code. The only
  guarantees are (a) no worker, and (b) no rows in `whatsapp_accounts`.
- Verified empty in this lab: `notification_rules`, `webhook_endpoints`,
  `workflows`, `whatsapp_accounts`, `system_settings`. Re-check before pointing
  this at any other environment:

```sql
SELECT (SELECT count(*) FROM notification_rules) AS rules,
       (SELECT count(*) FROM webhook_endpoints)  AS webhooks,
       (SELECT count(*) FROM workflows)          AS workflows,
       (SELECT count(*) FROM whatsapp_accounts WHERE access_token <> '') AS live_wa;
```

`start-api.ps1` additionally blanks `OPENAI_API_KEY`, `RESEND_API_KEY`, sets `EMAIL_ENABLED=false`, `PAYMENT_PROVIDER=noop` and
namespaces queues with `QUEUE_ENV_PREFIX=loadtest`. **The tracked `.env`
contains live OpenAI and Resend credentials**, so these overrides matter.

Routes deliberately excluded from every scenario: the payment webhooks (they
can mark payments PAID), WhatsApp
webhooks, patient-action token routes, `forgot-password` and `register-owner`
(both send real email), and `POST /ai/orchestrator/message` (real token spend).

## 6. Test accounts

Seeded by `npm run seed:perf -- --tier=T1`. Only the first 5 tenants have
loggable users: `perf.{owner,receptionist,doctor}.t{0..4}@t1.local.test`.
Passwords come from `TEST_PASSWORD` only.

---

## 7. Massive-scale phase (2026-09-02)

Added for the concurrent-user capacity campaign. Everything below reuses the
existing helpers, flows and thresholds — no parallel test stack.

### What was added

| file | purpose |
|---|---|
| `scenarios/vu-ladder.js` | 100 → 10,000 concurrent-user ladder with per-level recovery probes and an in-flight tenant-isolation assertion |
| `flows/mixed.js` → `prod-mix` profile | the brief's production-style distribution, converted from request shares to iteration weights |
| `data/integrity-check.sql` | post-scenario data-integrity verification (read-only) |
| `data/fixture.sql` §8 | promotes one owner + one receptionist in **every** perf tenant to the known test credentials, taking loggable tenants from 5 to 50 |
| `helpers/run-scenario.sh` | one measured run = k6 + monitor + a `pg_stat_statements` window + an integrity snapshot, all started and stopped together |
| `helpers/monitor.js` `--redis --gen --locks` | Redis/queue depth, load-generator CPU, and lock/deadlock sampling |
| `start-api.ps1 -Workers -PoolMax` | experiment knobs for the cluster-worker and pool-sensitivity comparisons; both default to "leave unset" |

### Reproduction

```bash
docker start ziyarati-perfaudit-postgres ziyarati-perfaudit-redis
docker cp tests/load/data/fixture.sql         ziyarati-perfaudit-postgres:/tmp/fixture.sql
docker cp tests/load/data/cleanup.sql         ziyarati-perfaudit-postgres:/tmp/cleanup.sql
docker cp tests/load/data/integrity-check.sql ziyarati-perfaudit-postgres:/tmp/integrity-check.sql
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -f /tmp/fixture.sql
powershell -File tests/load/start-api.ps1
```

```bash
TEST_PASSWORD='...' tests/load/helpers/run-scenario.sh ladder-run1 vu-ladder.js \
  TEST_TENANTS=50 MIX_PROFILE=prod-mix LEVELS=100,500,1000,2500,5000,10000 \
  RAMP=30s HOLD=60s GAP=30s THINK_MS=3000
```

Artifacts land in `tests/load/reports/massive/<tag>.{k6.log,monitor.json,pgstat-*.txt,integrity.txt}`.

### Things that will silently invalidate a massive-scale run

Read §4 first; these are additional.

- **`THINK_MS` is the difference between a user and a robot.** A VU with no think
  time offers unbounded load, so a 100→10,000 ladder reports "saturated" at every
  rung and measures queue depth, not users. Default 3000 ms ⇒ one action per
  ~3 s + latency per VU. State it with every VU number or the number means nothing.
- **The host runs out of ephemeral ports before the application runs out of
  capacity.** Windows' default range is 16,384 (`netsh int ipv4 show dynamicport
  tcp`); a 5,000-VU run was measured at 15,823 sockets in `Established` +
  `TIME_WAIT`. The symptom is `dial: i/o timeout` — a *connect* failure, not a
  server response. Above ~2,500 VUs the ladder describes the lab, not the app.
- **The generator competes for the same cores.** k6 peaked at 1,328% of the
  16-vCPU Docker engine while the API needs one core it cannot share. Always run
  `monitor.js --gen`; a level where generator CPU is high is not a clean
  application measurement.
- **`pg_stat_activity.state` cannot detect pool starvation.** `state='active'`
  peaked at 5 of 10 during a run in which 8,386 requests failed with pg-pool's
  `connectionTimeoutMillis`. A connection checked out by TypeORM between two
  statements reports as `idle`. The only reliable signal is the
  `timeout exceeded when trying to connect` error itself.
- **Boolean flags are not values.** `monitor.js --redis --gen` once resolved the
  Redis container name to `--gen` and lost a whole run's Redis data. The parser
  now rejects a value starting with `--`; keep it that way.
- **`kill -TERM` from Git Bash does not reach a Windows node process.** The
  monitor is stopped with a sentinel file; do not "simplify" it back to a signal.
