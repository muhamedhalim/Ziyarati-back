# ZiyaraTech k6 Load Test Suite

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

`start-api.ps1` additionally blanks `OPENAI_API_KEY`, `RESEND_API_KEY`,
`MOYASAR_SECRET_KEY`, sets `EMAIL_ENABLED=false`, `PAYMENT_PROVIDER=noop` and
namespaces queues with `QUEUE_ENV_PREFIX=loadtest`. **The tracked `.env`
contains live OpenAI and Resend credentials**, so these overrides matter.

Routes deliberately excluded from every scenario: the Moyasar webhook (it
**fails open** outside production and can mark payments PAID), WhatsApp
webhooks, patient-action token routes, `forgot-password` and `register-owner`
(both send real email), and `POST /ai/orchestrator/message` (real token spend).

## 6. Test accounts

Seeded by `npm run seed:perf -- --tier=T1`. Only the first 5 tenants have
loggable users: `perf.{owner,receptionist,doctor}.t{0..4}@t1.local.test`.
Passwords come from `TEST_PASSWORD` only.
