# Massive-Scale Capacity Matrix

**Date:** 2026-09-02 · **Target:** single-host local lab, `node dist/src/main`,
no worker process running · **Data tier:** T1, 50 tenants, 60,015 seeded
appointments · **k6:** v2.2.0 in Docker

Every figure is measured. Anything that could not be measured is written
**Not measured** rather than estimated.

---

## 0. How to read this

Two different ladders are reported because they answer different questions and
neither substitutes for the other:

- **VU ladder** — fixes the number of *concurrent users*. Answers "what does a
  user experience when N of them are on the system", which is how a capacity
  plan is stated. Requires a think time to mean anything (see below).
- **Arrival-rate sweep** — fixes *offered load* in actions/second. Answers "how
  much work can this system absorb", which is the capacity number itself.

**A VU is only a user if it thinks.** These runs use `THINK_MS=3000`: one action
every ~3 s plus latency. With no think time a VU is an infinite-speed robot and
100 of them already exceed this system's capacity — the ladder would then report
"saturated" at every rung and measure queue depth rather than users. A
`THINK_MS=0` control is included precisely so that difference is measured rather
than argued about.

## 1. Classification thresholds

Taken from the repository's own SLOs in `tests/load/config/thresholds.js`, not
invented for this report.

| endpoint class | p95 budget | endpoints scored against it |
|---|---|---|
| `cached_read` | 300 ms | `dashboard` |
| `list_read` | 800 ms | `appointments:list`, `staff:list`, `activity:list` |
| `search_read` | 1,200 ms | `crm:search:term` |
| `availability` | 1,200 ms | `availability:windows` |
| `write` | 1,500 ms | `appointments:create` |
| `auth` | 1,000 ms | `auth:login` — **not exercised**: the suite logs in once in `setup()`, so this class has no data in the ladder or sweep |

| verdict | all of |
|---|---|
| **HEALTHY** | 5xx = 0 · error rate < 1% · every endpoint class inside its p95 budget · no pool-connection timeouts · no deadlocks · no unbounded queue growth · no memory growth that does not recover |
| **DEGRADED** | one or more classes over budget, but 5xx = 0 and error rate < 1% |
| **SATURATED** | achieved throughput stops rising with offered load, or error rate 1–10%, or pool-connection timeouts begin |
| **FAILED** | sustained 5xx · connection exhaustion · runaway latency · unbounded queue growth · memory exhaustion · any data-integrity violation |

---

## 2. VU ladder — two independent runs, identical configuration

`prod-mix`, 50 tenants, `THINK_MS=3000`, 30 s ramp → 60 s hold → 10 s drain per
level, 30 s recovery probe at 5 it/s between levels.

### Run 1

| VUs | achieved req/s | p50 | p95 | p99 | error rate | recovery p95 | recovery error rate |
|---|---|---|---|---|---|---|---|
| 100 | 39 | 35 ms | 119 ms | 152 ms | 0.18% | 138 ms | 0.00% |
| 500 | 120 | 724 ms | 4,814 ms | 5,430 ms | 0.67% | 137 ms | 3.05% |
| 1,000 | 134 | 2,298 ms | 15,092 ms | 16,383 ms | 0.66% | 145 ms | 1.49% |
| 2,500 | 154 | 7,193 ms | 45,042 ms | 50,387 ms | 1.45% | 4,348 ms | 6.42% |
| 5,000 | 177 | 16,713 ms | 59,996 ms | 59,997 ms | 17.10% | 35,650 ms | 17.27% |
| 10,000 | *582* | *0 ms* | 33,179 ms | 38,317 ms | 88.94% | 15,336 ms | 20.74% |

### Run 2

| VUs | achieved req/s | p50 | p95 | p99 | error rate | recovery p95 | recovery error rate |
|---|---|---|---|---|---|---|---|
| 100 | 39 | 34 ms | 121 ms | 153 ms | 0.10% | 147 ms | 0.45% |
| 500 | 126 | 671 ms | 4,348 ms | 5,131 ms | 0.55% | 143 ms | 2.74% |
| 1,000 | 132 | 2,453 ms | 16,020 ms | 17,405 ms | 0.48% | 136 ms | 2.31% |
| 2,500 | 157 | 6,889 ms | 44,666 ms | 49,741 ms | 1.35% | 5,021 ms | 1.91% |
| 5,000 | 178 | 15,918 ms | 59,995 ms | 59,997 ms | 16.73% | 44,217 ms | 30.28% |
| 10,000 | *530* | *7,085 ms* | 36,190 ms | 44,988 ms | 83.73% | 20,160 ms | 13.42% |

### Variability

| VUs | req/s spread | p95 spread | error-rate spread |
|---|---|---|---|
| 100 | 0% | 1.7% | 0.08 pt |
| 500 | 4.8% | 9.7% | 0.12 pt |
| 1,000 | 1.5% | 6.2% | 0.18 pt |
| 2,500 | 1.9% | 0.8% | 0.10 pt |
| 5,000 | 0.6% | 0.0% | 0.37 pt |
| **10,000** | **9.4%** | **9.1%** | **5.2 pt** |

Everything up to 5,000 VUs reproduces within ~10%; no third control run was
needed. **Only the 10,000-VU row is materially unstable**, which is consistent
with it being limited by the host's transport layer rather than the application
(§ report 18). A third run was not made at 10,000 because a more stable number
there would still describe the lab.

### Reading the 10,000-VU row

Both italicised figures are artefacts, not throughput:

- "582 req/s" and "530 req/s" are dominated by **connections that failed to
  establish**, which complete in microseconds and inflate the request count.
- Run 1's "p50 = 0 ms" is the same thing: more than half of all requests never
  reached the server.

The honest statement for this level is **83.7–88.9% of requests failed, most of
them before the API saw them**.

### Classification

| VUs | verdict | why |
|---|---|---|
| **100** | **HEALTHY** | p95 119–121 ms; every endpoint class inside budget; error rate ≤ 0.18%; p99 ≤ 153 ms, three orders of magnitude below the 10 s pool-wait threshold, so pool-timeout 5xx are structurally impossible here |
| **500** | **DEGRADED** | aggregate p95 4.3–4.8 s — 3x the *loosest* budget in the table (`write`, 1,500 ms), so the bulk of traffic is outside SLO; errors still < 1%; p99 ≤ 5.4 s, below the 10 s pool-wait threshold, so no pool-timeout 5xx. Per-class detail at this level is **Not measured** — the ladder emits only an aggregate; § 3.1 gives the per-class breakdown at equivalent throughput |
| **1,000** | **SATURATED** | throughput has stopped rising (120→134 req/s for 2× the users); p99 15–17 s crosses the 10 s pool-wait threshold, so pool-starvation 5xx begin here |
| **2,500** | **SATURATED** | error rate crosses 1%; recovery p95 jumps from ~140 ms to 4.3–5.0 s — the first level from which the system does **not** immediately return to normal |
| **5,000** | **FAILED** | 16.7–17.1% error rate; p95 pinned at the 60 s client timeout; recovery p95 35–44 s |
| **10,000** | **FAILED — environment-bound** | 83.7–88.9% errors, dominated by `dial: i/o timeout`. Describes the lab's transport limits, not the application |

**Per-level 5xx counts are Not measured** — the ladder scenario emits `http_5xx`
as a run total (8,386 and 8,672), not per step. The level attribution above is an
*inference from a hard threshold*, not a measurement: every 5xx in this campaign
was pg-pool's `connectionTimeoutMillis`, which cannot fire before a caller has
waited 10 s, so a level whose p99 is under 10 s cannot contain one. The
arrival-rate sweep below carries the per-step endpoint detail.

### Recovery after each burst

The recovery probe (5 it/s for 30 s immediately after each level drains) is the
cleanest single indicator in this report:

| after | recovery p95, run 1 / run 2 | back to normal? |
|---|---|---|
| 100 VUs | 138 / 147 ms | yes — indistinguishable from idle |
| 500 VUs | 137 / 143 ms | **yes — full recovery even though the burst itself ran at p95 4.5 s** |
| 1,000 VUs | 145 / 136 ms | **yes** |
| 2,500 VUs | 4,348 / 5,021 ms | no — 30 s was not enough to drain |
| 5,000 VUs | 35,650 / 44,217 ms | no — still saturated 30 s later |
| 10,000 VUs | 15,336 / 20,160 ms | no |

**The system recovers cleanly and completely from bursts up to 1,000 concurrent
users**, returning to ~140 ms p95 within 30 seconds of load being removed, even
after a burst that ran at 15 s p95. The first burst it does not shrug off inside
30 s is 2,500.

---

## 3. Arrival-rate sweep — the capacity number

`prod-mix`, 50 tenants, 45 s per step, 5 s between steps. Offered load is held
fixed in iterations/second regardless of how the server responds, so these rows
are directly comparable to each other. **Generator CPU peaked at 117–173% of the
1,600% engine budget during these sweeps** (versus 1,328% during the VU ladder),
so every row below is a clean application measurement.

`endpoint classes over SLO` is scored against `config/thresholds.js` — the
repository's own per-class budgets, not a number invented here.

### 3.1 Single process, pool 10 (`sweep-w1`) — the production default today

| offered it/s | achieved req/s | p50 | p95 | p99 | error | classes over SLO | verdict |
|---|---|---|---|---|---|---|---|
| 20 | 28 | 32 ms | 107 ms | 130 ms | 0.00% | – | HEALTHY |
| 30 | 41 | 31 ms | 98 ms | 132 ms | 0.33% | – | HEALTHY |
| 40 | 55 | 30 ms | 99 ms | 132 ms | 0.00% | – | HEALTHY |
| 50 | 70 | 30 ms | 105 ms | 145 ms | 0.00% | – | HEALTHY |
| 60 | 83 | 33 ms | 132 ms | 187 ms | 0.11% | – | HEALTHY |
| **80** | **112** | 79 ms | 472 ms | 854 ms | 0.00% | – | **HEALTHY — last clean point** |
| 100 | 122 | 2,011 ms | 11,307 ms | 13,734 ms | 0.24% | **all 7** | SATURATED |
| 120 | 124 | 2,225 ms | 14,379 ms | 15,844 ms | 0.86% | **all 7** | SATURATED |

Per-endpoint p95 against budget at the transition:

| endpoint | budget | at 60 it/s | at 80 it/s | at 100 it/s |
|---|---|---|---|---|
| `dashboard` | 300 ms | 57 | 130 | **2,059** |
| `appointments:list` | 800 ms | 60 | 171 | **2,996** |
| `staff:list` | 800 ms | 79 | 266 | **4,917** |
| `activity:list` | 800 ms | 29 | 109 | **2,028** |
| `crm:search:term` | 1,200 ms | 42 | 136 | **2,942** |
| `availability:windows` | 1,200 ms | 84 | 484 | **8,557** |
| `appointments:create` | 1,500 ms | 195 | 908 | **13,901** |

Every class is inside budget at 80 it/s and **every class breaches simultaneously
at 100**. That simultaneity is itself the diagnosis: a shared resource — the
single event loop — not any individual endpoint.

`server_5xx` = **0** across the entire sweep, and `dropped_iterations` = 1,809
(8% of scheduled work). The dropped iterations are concentrated at 100 and
120 it/s, where slow responses held k6's 600 VUs long enough that it could not
launch everything it had scheduled. That means offered load at those two steps
was *below* nominal — the plateau is real and would not have been higher.

### 3.2 API worker comparison — identical sweep, only `API_CLUSTER_WORKERS` differs

| offered it/s | w1 (pool 10) | w1 (pool 30) | **w2** (pool 10) | **w4** (pool 10) |
|---|---|---|---|---|
| 60 | 83 req/s · p95 132 ms | 82 · 114 ms | 85 · 93 ms | 84 · 86 ms |
| 80 | 112 · **472 ms** | 111 · 164 ms | 113 · 106 ms | 110 · **94 ms** |
| 100 | 122 · **11,307 ms** | 135 · 4,847 ms | 138 · 552 ms | **142 · 243 ms** |
| 120 | 124 · **14,379 ms** | 140 · 11,171 ms | **165 · 4,737 ms** | **170 · 1,962 ms** |
| **max achieved req/s** | **124** | **140** (+13%) | **165** (+33%) | **170 (+37%, not yet saturated)** |
| **last all-SLO-clean rate** | 80 it/s | 80 it/s | 100 it/s | 100 it/s |
| requests served | 29,316 | 30,709 | 32,047 | 32,234 |
| dropped iterations (generator-side) | **1,809** | 870 | 24 | **0** |
| 5xx | 0 | 0 | 0 | 0 |
| timeouts / connection failures | 71 | 105 | 33 | 35 |
| peak PostgreSQL connections | 12 | 31 | 21 | **41** |
| peak `active` of those | 5 | 6 | 6 | 9 |
| peak `idle in transaction` | 4 | 8 | 4 | 3 |
| API processes | 1 | 1 | 3 (primary + 2) | 5 (primary + 4) |
| API CPU-seconds for the run | 343.2 | 333.8 | 412.5 | 440.6 |
| CPU ms per request | 11.7 | **10.9** | 12.9 | **13.7** |
| API RSS after the run | 785 MB | 758 MB | 995 MB | **1,947 MB** |
| deadlocks / ungranted locks | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| generator CPU peak (of 1,600%) | 118% | 143% | 122% | 173% |

**Connection budget confirmed empirically**, matching the calculation exactly:
`workers × API_DB_POOL_MAX` plus one monitor session — 10→12, 20→21, 40→41,
30→31.

Two costs of clustering, both measured rather than assumed:

- **CPU per request rises ~17%** (11.7 → 13.7 ms) going from 1 to 4 workers.
  Each worker keeps its own in-process caches, its own pool and its own
  connections, so work that was done once is now done up to four times.
- **Memory rises ~2.5×** (785 MB → 1,947 MB resident across all API processes).
  Four workers is not a free 4× — it is ~4× the memory for ~1.37× the throughput
  at the rates tested here.

The `w1 pool 30` column is *cheaper* per request (10.9 ms) than the default
`w1 pool 10` (11.7 ms), because with a deeper pool fewer requests spend CPU
waiting and retrying. That is a genuine but small effect, and it is the ceiling
of what pool tuning alone can buy.

### 3.3 CPU or the pool? The experiment that separates them

`w1 pool 30` and `w2 pool 10` are the controlled pair. The single process has
**more** connections (30 vs 20) and **less** CPU parallelism (1 vs 2):

| | connections | processes | max req/s |
|---|---|---|---|
| w1, pool 30 | 30 | 1 | 140 |
| w2, pool 10 | 20 | 2 | **165** |

More connections on one process buys **+13%**. Fewer connections on two
processes buys **+33%**. **CPU parallelism is the dominant constraint and the
pool is a real but secondary one.** Neither is the database: `pg_stat_activity`
active peaked at 5 / 6 / 9 of 10 / 20 / 40, zero deadlocks and zero ungranted
locks in every configuration.

This is why raising `DB_POOL_MAX` was rejected as the remedy: it moves the number
by 13% while costing connection budget that the *worker* process and rolling
deploys also have to fit inside.

### 3.4 Pushing 2 and 4 workers to their limits

The 20–120 it/s sweep never saturated 2 or 4 workers, so it was re-run at
120–300 it/s. **Read this table with §3.5 — the generator could not deliver the
nominal rate at the top of it.**

| offered it/s | **w2** req/s · p95 | **w4** req/s · p95 |
|---|---|---|
| 120 | 168 · 1,319 ms | 159 · 6,232 ms *(anomalous — see below)* |
| 150 | 181 · 8,888 ms | 202 · 5,586 ms |
| 180 | 230 · 8,900 ms | 245 · 6,382 ms |
| 220 | **244** · 8,625 ms | 268 · 8,576 ms |
| 260 | 229 · 8,551 ms | 281 · 7,650 ms |
| 300 | 219 · 8,968 ms | **317** · 6,568 ms |
| requests served | 57,927 | 67,000 |
| **dropped iterations** | **13,989 (25%)** | **7,173 (13%)** |
| 5xx | **0** | **0** |
| peak pg connections | 22 | 42 |
| peak pg `active` | 9 | 9 |
| API CPU-seconds | 629.3 | 816.2 |
| CPU ms per request | 10.9 | 12.2 |
| API RSS after | 1.32 GB | 2.66 GB |
| generator CPU peak | 137% | 281% |

**The `w4` 120 it/s row is an anomaly, not a data point.** Its p95 (6,232 ms) is
worse than both its own next step (150 it/s → 5,586 ms) and the same rate in the
earlier sweep (1,962 ms). Most likely cause: it is the *first* step of the run
against four freshly started processes, so four sets of cold in-process caches
and un-warmed JIT are being paid at once. **Needs verification** — a dedicated
warm-up step would settle it, and none was run.

There is also **hysteresis between adjacent steps near the knee**: `sweep-w2`
measured 120 it/s at p95 4,737 ms when it followed a 100 it/s step that was
already queueing, while `sweepx-w2` measured the same rate at p95 1,319 ms as its
first step. A sweep step inherits the previous step's backlog; the 5 s inter-step
gap is not always enough to drain it.

### 3.5 Where the generator, not the application, became the limit

`dropped_iterations` is a **generator-side** metric: k6 could not start work it
had scheduled, so offered load was *below* nominal. It is the opposite of a
server failure and the two must not be conflated.

`progressive-sweep.js` allocates `maxVUs: 600`. When responses slow, VUs stay
occupied, and the deliverable rate is bounded by `600 ÷ mean iteration duration`.
At 300 it/s with iterations averaging ~3 s, that bound is ~200 it/s — below the
nominal 300.

| | w1 | w2 | w4 |
|---|---|---|---|
| dropped, low-rate sweep (20–120) | 1,809 (8%) | 24 (0.1%) | **0** |
| dropped, high-rate sweep (120–300) | not run | 13,989 (25%) | 7,173 (13%) |

Consequences, stated precisely:

- **w1's plateau at ~124 req/s is a real server ceiling.** Its dropped
  iterations are a *consequence* of the server holding VUs — throughput was flat
  across 100 and 120 it/s while latency climbed, which is saturation, not a
  generator shortfall.
- **w2's apparent decline above 220 it/s (244 → 229 → 219) is NOT established as
  congestive collapse.** At those steps the generator was delivering ~75% of
  nominal, so lower achieved throughput is at least partly a smaller offered
  load. `244 req/s` should be read as a **lower bound**, not a peak.
- **w4's ceiling was never found.** At 300 it/s it was still climbing (317 req/s),
  with **zero 5xx**, `pg_stat_activity` active at 9 of 40, and no deadlocks. The
  application was not failing; the lab ran out of ability to offer load.

Finding w4's true ceiling needs a load generator on a separate machine, or a
larger `maxVUs` with the generator's own CPU headroom measured. **Not measured.**

---

## 4. Same-tenant hotspot

500 VUs, 20 s ramp → 60 s hold, `prod-mix`, single API process. The **only**
difference between the two runs is which tenants the VUs are assigned to:
`TENANT_SKEW=0` spreads them evenly across all 50, `TENANT_SKEW=0.8` pins 80% of
them to one clinic. Same duration, same profile, same code, back to back.

| | even spread | **80% on one clinic** | delta |
|---|---|---|---|
| achieved req/s | 124 | 124 | **0%** |
| p50 | 779 ms | 910 ms | **+17%** |
| p95 | 4,909 ms | 5,903 ms | **+20%** |
| error rate | 0.40% | 0.13% | — |
| 5xx | 0 | 0 | — |
| recovery p95 | 132 ms | 136 ms | — |
| API CPU-seconds | 145.2 | 146.5 | +0.9% |
| DB queries | 136,794 | 131,880 | −3.6% |
| pg `active` max | 5 | 5 | — |
| **pg `waiting_on_lock` max** | **0** | **1** | **lock waiting appears** |
| **ungranted locks max** | **0** | **1** | |
| deadlocks | 0 | 0 | — |

**A same-tenant hotspot costs about 20% of tail latency at identical throughput
and identical CPU.** The mechanism is visible rather than inferred: row-lock
waiting appears only in the skewed run. The most likely source is the per-tenant
usage-counter row that every booking's quota admission updates inside the
transaction, which serialises concurrent bookings for one clinic; per-tenant
cache keys and tenant-prefixed index ranges contribute in the same direction.

The magnitude is modest — one waiter at peak, not a pile-up — so per-tenant
serialisation is a real cost but **not** this system's limiting factor at any
load measured. Worth re-testing if a single clinic ever becomes a large share of
total traffic.

Tenant isolation held in both runs: 520 and 501 cross-tenant probes,
**0 violations**.

---

## 5. The think-time control

Everything in §2 depends on the claim that a VU without think time is not a
user. That claim was measured, not asserted. **100 VUs, identical in every
respect except `THINK_MS`:**

| | `THINK_MS=3000` | `THINK_MS=0` | ratio |
|---|---|---|---|
| achieved req/s | 39 | **112** | **2.9×** |
| p50 | 35 ms | 433 ms | 12× |
| p95 | 119 ms | **2,726 ms** | **23×** |
| p99 | 152 ms | 2,913 ms | 19× |
| error rate | 0.18% | 0.00% | — |
| 5xx | 0 | 0 | — |

**100 VUs with no think time offer 112 req/s — exactly the system's measured
healthy ceiling (§3.1: 80 it/s = 112 req/s).** One hundred infinite-speed robots
fully saturate this API on their own.

That is the whole argument in one row. A 100 → 10,000 VU ladder run without
think time would have reported "saturated" at the very first rung and every rung
after it, and the resulting "capacity" number would have described k6's queue
rather than the application. Any VU figure quoted from this report without its
think time attached is meaningless.

---

## 6. Throughput and concurrency are two different ceilings

Worth stating explicitly, because converting one into the other is the easiest
way to publish a wrong number from correct data.

| | arrival-rate sweep @ 80 it/s | VU ladder @ 500 VUs |
|---|---|---|
| achieved throughput | 112 req/s | 120 req/s |
| p95 | **472 ms** | **4,814 ms** |
| requests in flight | ~40 | ~500 |

**Almost identical work per second; ten times the latency.** By Little's Law
`W = L / λ`, holding λ fixed and raising L raises W proportionally — 500 in
flight at ~79 it/s implies ~6.3 s in the system, and that is what the ladder
measured.

Consequences for how this report may be quoted:

- A throughput figure (req/s) says nothing on its own about how many users are
  comfortable.
- A VU figure says nothing on its own about how much work is being done.
- Neither may be derived from the other. Where only one instrument was run
  against a configuration — as with 2 and 4 workers, which were compared by
  arrival rate only — the other axis is **Not measured**, not estimated.

---

## 7. Thirty-minute soak — FAILED, for a reason worth having found

Run at **80 it/s**, the highest all-SLO-clean rate for a single process (§3.1),
`prod-mix`, 50 tenants, single process, `SOAK_RELOGIN=true` with a 10-minute
re-authentication interval. 362 server-side samples.

### Headline result

| | value | verdict |
|---|---|---|
| requests | 108,363 | |
| achieved | 58.1 req/s against ~112 offered | **FAILED** |
| p50 / p95 / p99 | 5,290 / **25,089** / 42,096 ms | **FAILED** |
| error rate | **36.75%** | **FAILED** |
| HTTP 5xx | **12,883** (all pg-pool `connectionTimeoutMillis`) | **FAILED** |
| deadlocks | **0** | pass |
| **heap growth over 31 min** | **−22 MB** | **pass — no leak** |
| **RSS growth over 31 min** | **−222 MB** | **pass — no leak** |
| queue depth (`wait` first/last/max) | 0 / 0 / 0 | pass |
| Redis memory growth | 0 MB | pass |
| generator CPU peak | 114% of 1,600% | the generator was not the limit |

### The failure has a single, identifiable cause and a timestamp

Five-minute windows make it unambiguous:

| minutes | event-loop lag p99 max / avg | RSS avg | heap avg | pg `active` max | pg `idle in transaction` max | API CPU (cores) |
|---|---|---|---|---|---|---|
| 0–5 | 0.213 / 0.041 s | 454 MB | 164 MB | 8 | 5 | 1.18 |
| 5–10 | **0.040 / 0.027 s** | 400 MB | 163 MB | 5 | 4 | 1.32 |
| **10–15** | **12.348 / 1.211 s** | 396 MB | 163 MB | 5 | **10 (whole pool)** | 1.07 |
| 15–20 | 7.608 / 1.457 s | 392 MB | 149 MB | 2 | **10** | 0.99 |
| 20–25 | 5.620 / 1.225 s | 393 MB | 162 MB | 3 | 8 | 1.00 |
| 25–31 | 11.325 / 1.370 s | 392 MB | 156 MB | 3 | **10** | 0.99 |

**The first ten minutes are healthy** — event-loop lag p99 of 0.04 s, throughput
at 72–75 it/s, no pool pressure. **At minute 10 the scheduled re-authentication
fires and the run never recovers**: lag jumps by three orders of magnitude, the
entire 10-connection pool goes `idle in transaction`, and the API sits pegged at
~1.0 core for the remaining 20 minutes. Root cause and the 86%-of-a-core
arithmetic: **MASSIVE_SCALE_FINDINGS.md § MS-008**.

### What the soak still establishes, despite failing

The soak's own question — *does anything drift over time?* — is answered
cleanly, and the answer is good:

- **No memory leak.** RSS and heap both ended *lower* than they started, across
  31 minutes and 108,363 requests. Nothing accumulated.
- **No connection leak.** Pool totals returned to baseline; the
  `idle in transaction` peaks track load, not time.
- **No queue growth.** `wait` and `active` were 0 at the first sample, the last
  sample, and every sample between.
- **No lock accumulation.** Zero deadlocks; ungranted locks peaked at 1.
- **No Redis growth.** 0 MB across the window.
- **No latency creep independent of the incident.** Windows 15–20, 20–25 and
  25–31 do not get progressively worse — they oscillate around the same degraded
  plateau, which is congestion, not drift.

### Honest verdict

**This is a failed soak.** It is reported as failed. But the failure is a
*discrete incident with a known trigger*, not the gradual degradation a soak
exists to detect — and on that question the system passed. A re-run with MS-008
addressed (or with `SOAK_RELOGIN=false` and a token lifetime longer than the
window) would be needed to claim a clean 30-minute soak, and has **not** been
done.

---

## 8. Concurrency bisection — closing the 100-to-500 gap

The first ladder sampled 100 (healthy) then jumped to 500 (degraded), leaving the
actual ceiling unlocated. Same think time, profile, ramp and hold as that ladder,
so these rows slot straight into § 2.

| VUs | achieved req/s | p50 | p95 | p99 | error rate | recovery p95 | verdict |
|---|---|---|---|---|---|---|---|
| 100 *(from § 2)* | 39 | 35 ms | 119 ms | 152 ms | 0.18% | 138 ms | HEALTHY |
| **150** | 58 | 37 ms | **127 ms** | 183 ms | 0.22% | 120 ms | **HEALTHY** |
| **200** | 76 | 45 ms | **206 ms** | 369 ms | 0.24% | 119 ms | **HEALTHY — last clean level** |
| **250** | 90 | 83 ms | **505 ms** | 831 ms | 0.28% | 116 ms | **DEGRADED** (past the 300 ms `cached_read` budget) |
| 300 | 99 | 215 ms | 1,433 ms | 1,902 ms | 0.45% | 103 ms | DEGRADED |
| 400 | 102 | 615 ms | 4,035 ms | 4,475 ms | 0.48% | 111 ms | DEGRADED |
| 500 *(from § 2)* | 120 | 724 ms | 4,814 ms | 5,430 ms | 0.67% | 137 ms | DEGRADED |

**5xx = 0 at every level. Tenant isolation: 1,642 probes, 0 violations.
`dropped_iterations` = 0, so the generator delivered everything it was asked to.**

### The answer

**~200 concurrent users at 3 s think time is the healthy ceiling for a single
process**, achieving 76 req/s. The first level over budget is 250.

Two things this makes visible that the coarse ladder did not:

1. **Throughput saturates around 100 req/s in closed-loop terms** — 300 VUs give
   99 req/s and 400 give 102. Everything past that is queue, which is why p95
   goes 505 → 1,433 → 4,035 ms while throughput moves 90 → 99 → 102.
2. **Recovery stays perfect throughout.** The post-level probe reads 103–120 ms
   at *every* level including 400 VUs. The system is queueing, not breaking, all
   the way to the point where the coarse ladder's 1,000-VU level starts producing
   pool-timeout 5xx.

### Caveat on the per-class scoring

The ladder emits an aggregate p95, not per-endpoint sub-metrics, so the verdicts
above are scored on the aggregate against the tightest class budget (300 ms,
`cached_read`). Cross-checking against the arrival-rate sweep at equivalent
throughput supports it: at 50–60 it/s (70–83 req/s, i.e. the 200-VU level's
work rate) the sweep measured `dashboard` p95 at 46–57 ms and every other class
far inside budget. Strictly, **per-class p95 at each VU level is Not measured**.
