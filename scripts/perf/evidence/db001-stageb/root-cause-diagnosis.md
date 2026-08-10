# PERF-DB-001 Stage B — Root-Cause Diagnosis (T146/T147, 2026-08-10)

**Stack**: isolated `ziyarati-perf-db001-postgres` (5435) / `ziyarati-perf-db001-redis` (6381), T2
dataset (500 tenants / 900k appointments, seeded counts identical to Stage A's own T068 run — see
main report). API process: `node dist/src/main.js`, port 3011, `DB_POOL_MAX=15` (explicitly set
to match `EV-database-T074-pool-saturation`'s recorded `poolMax`, since the tracked `.env` default
is `10`). `pg_stat_statements` enabled on this isolated stack only (never enabled on shared
infrastructure — Stage A's own gate explicitly forbade that on the *shared* stack; this is a
dedicated, disposable database).

## 1. Reproduction of the original finding

`node scripts/perf/db001-pool-harness.js --phase=before --tag=owner-t0`, `GET
/api/v1/appointments?limit=50`, logged in as `perf.owner.t0@t2.local.test` (owner role, 125
permissions):

| | N=10 median | N=25 median | Δ |
|---|---:|---:|---:|
| This run | 228.9ms | 451.1ms | **+97.1%** |
| Original (`EV-database-T074-pool-saturation`) | 338ms | 628ms | +86% |

Same phenomenon, same order of magnitude — the baseline reproduces. Raw data:
`before-owner-t0-1786357580227.json` (this directory).

## 2. Live connection-pool lifecycle capture (the gap Stage A itself disclosed it never closed)

`pg_stat_activity` polled every 50ms throughout both bursts (first time this has been captured
live for this finding — `load-profiles.md` T112/T113 explicitly recorded that no prior measurement,
Stage A included, ever captured a live snapshot at the test's peak moment):

| | N=10 | N=25 |
|---|---:|---:|
| Peak **active** connections | 5 | 5 |
| Peak **idle-in-transaction** | 2 | 6 |
| Configured pool max | 15 | 15 |

**Active connections never approached the 15-connection pool max in either burst.** Pool
exhaustion — "all connections busy, new requests queue for a slot" — requires the active count to
reach the pool max; it topped out at 5/15 (33%). This directly rules out connection-pool queueing
as the latency driver for this specific reproduction.

## 3. Server-side query execution time (`pg_stat_statements`, ground truth — immune to
client/network noise)

Accumulated over 263 calls of each appointments-path query during this session's testing (raw
output: `pg-stat-statements-before.txt`, this directory):

| Query | Mean | Max |
|---|---:|---:|
| Appointments data query (joins: branch, customer, staff, services) | 1.94ms | 5.56ms |
| Appointments COUNT query | 1.68ms | 4.75ms |
| `loadPrincipal`'s user+roles+permissions+tenant JOIN (JwtStrategy, every request) | 3.56ms | 6.61ms |

All sub-10ms even at their measured maximum. Summed, the actual database work for one request is
roughly 6-12ms — nowhere near explaining a 228-451ms end-to-end median, let alone the 25-concurrent
tail.

## 4. Client-side artifact ruled out

Re-ran the same burst using an explicit `undici.Agent({ connections: 200 })` (well above any
default per-origin limit) instead of the default global dispatcher, against the lightweight
`/api/v1/system/health/readiness` endpoint:

| | default dispatcher | explicit 200-connection Agent |
|---|---:|---:|
| N=25 median | 65.0ms | 63.1ms |
| Δ vs N=10 | +167.5% | +126.2% |

No meaningful change — the client's own HTTP connection pool is not the bottleneck.

## 5. The `@Public()` readiness endpoint — no auth, no guard chain, two cheap pings — degrades

`GET /api/v1/system/health/readiness` (bypasses `JwtAuthGuard`/`loadPrincipal`/RBAC/subscription/
tenant guards entirely, `@Public()`, handler is `Promise.all([pingDb, redisPing])`):

| | N=10 median | N=25 median | Δ |
|---|---:|---:|---:|
| readiness | 24.3ms | 65.0ms | **+167.5%** |

A trivial, unauthenticated, two-ping endpoint shows a **larger relative degradation** than the
DB-heavy, fully-guarded appointments endpoint (+97.1%). If connection-pool queueing on the
appointments path's specific queries were the driver, a handler with no RBAC query and two cheap
pings should not degrade this much, or more.

## 6. Server CPU accounting (`Get-Process` delta, same methodology as `PERF-BE-003`/`PERF-CACHE-001`)

25-concurrent burst against `/api/v1/appointments?limit=50` (+1 login): CPU-seconds
11.375 → 13.0625 = **1.6875 CPU-s for 26 requests ≈ 65ms CPU-time per request**, on a
**single, unclustered Node process** (no PM2/cluster config found in the repo — confirmed by
absence of any `ecosystem*.js`/cluster invocation).

25 requests × ~65ms of CPU-bound work, serialized on one JS thread (Node cannot parallelize
synchronous work across concurrent requests without `cluster`/`worker_threads`), predicts a total
CPU-bound queueing window of ~1.6s spread across the burst — closely matching the observed spread
from the fastest request (~65ms) to the slowest (~584-600ms) in the raw N=25 samples. This is the
single most consistent explanation for the measured latency curve.

## 7. Postgres CPU (`docker stats`)

Idle: 0.00% CPU. Under a **sustained** load (8 consecutive rounds of 25-concurrent requests, ~200
requests total in a tight loop): 127.8% CPU — multiple backend processes briefly active in
parallel, consistent with normal multi-connection utilization for cheap, fast (sub-10ms) queries,
not saturation (no elevated query times, no waiting backends observed in any snapshot).

## Verdict

The measured latency degradation reproduces T074's original finding in magnitude, but the
mechanism is **not** PostgreSQL connection-pool queueing:

- Pool never exceeded 33% of its configured max.
- Individual query execution times stay sub-10ms under the exact load that produces
  450-600ms end-to-end latency.
- A handler with zero DB-heavy guard work and two trivial pings degrades as much or more.
- Client-side HTTP concurrency limits were explicitly ruled out.
- Server CPU-time accounting on a single, unclustered Node process explains the observed curve
  far more precisely than a connection-pool story does.

**The dominant bottleneck is Node.js single-process request-handling concurrency (CPU/event-loop),
not the database connection pool.** Per this session's explicit instruction — *"If the measured
root cause belongs to another finding, do not force a PERF-DB-001 fix. Record the dependency and
stop"* — no PERF-DB-001 code change was made. See the main report for the full verdict and
recommended follow-up.
