# PERF-CACHE-001 — After-fix measurement (T154, 2026-08-10)

Same isolated `LOCAL`/T1 stack, same procedure as `before-summary.md`, rebuilt `dist/` with `FailsafeThrottlerStorage` in place, API restarted (new PID).

## Normal Redis operation (fix in place)

- `harness-normal-after-fix.json`: public readiness p50=15.2ms/p95=28.3ms/p99=69.8ms (was 15.1/40.9/96.3 before — no regression, within run-to-run noise); authenticated `/api/v1/branches` p50=42.5ms/p95=55.3ms/p99=56.3ms (was 35.3/57.5/62.8 — comparable); 401/403 unchanged; login success 200; login failure 401; 15-concurrent burst 15/15 200, totalMs=90.5ms (was 97.8ms).
- 429 burst re-run (`GET /api/v1/whatsapp/webhooks/verify`, 60/min): identical result — 60×403 then 429 from request 61. **Rate-limiting semantics unchanged under normal operation.**

**Conclusion: zero measurable normal-operation cost from the fix** — every call still goes to Redis first; the in-memory fallback path is only exercised when Redis itself errors.

## Real Redis outage (same ~20s-class window, fix in place)

Every scenario in `harness-during-outage-after-fix.json`, plus direct `curl` probes:

| Scenario | Before fix | After fix |
|---|---|---|
| Public readiness | 20/20 → **500** (raw ioredis stack trace) | 20/20 → **503**, clean structured JSON (`HealthController`'s own pre-existing Redis-dependency check — not new code from this fix; the request now reaches it instead of crashing one guard earlier) |
| Unauthenticated `/api/v1/branches` | 500 | **401**, correct `UNAUTHORIZED` |
| Login, correct credentials | 500 (**login completely broken**) | **200, real session issued** — login works during a Redis outage |
| Login, wrong password | 500 (indistinguishable from correct-credentials case) | **401 `INVALID_CREDENTIALS`**, correct and distinguishable |
| Authenticated `GET /api/v1/branches` (valid session) | not reachable (login itself was broken) | 20/20 → **200**, p50=38.0ms/p95=64.3ms/p99=72.6ms — **comparable to normal-operation latency**, not degraded |
| CSRF-protected POST, no token | not reachable | **403**, correct (`CsrfGuard`, in-memory, unaffected by Redis state either way) |
| 15-concurrent public-route burst | 15/15 → 500, totalMs=77.6ms | 15/15 → **503** (clean), totalMs=163.7ms — still fails fast, no hang, no crash |

**Never an unhandled 500 in any scenario.** The one non-2xx path still present after the fix (`503` on the public readiness route) is `HealthController`'s own existing, intentional Redis-dependency reporting — separate code, unrelated to `ThrottlerGuard`, working exactly as designed once the guard chain stops crashing before reaching it.

## CPU (100-request burst during outage, same `Get-Process` methodology as `before-summary.md` and PERF-BE-003)

- Before fix: 15.921875→16.609375 CPU-s / 100 req = **~6.9ms/req** (cheapest possible outcome: one thrown error, zero further processing — the app was broken, not efficient).
- After fix: 12→13.40625 CPU-s / 100 req = **~14.1ms/req** — **higher, disclosed honestly, and expected**: the request now runs the full guard chain (local in-memory throttle check) and reaches real controller logic (the readiness endpoint's own Redis+DB status probe) instead of dying at the first guard. This is the cost of the app doing its actual job correctly during an outage instead of crashing instantly; it does not apply to normal operation, which is unchanged (see above).

## Recovery (container restarted, same polling procedure)

- Before fix: ~5.2s to first clean `200`.
- After fix: ~2.6s to first clean `200`. Both figures reflect `ioredis`'s own reconnect logic on `AppRedisService.application` — **this fix does not touch reconnection**, so the two numbers are treated as run-to-run noise, not a claimed improvement.
- **Confirmed Redis-backed throttling resumes automatically, no app restart**: a `{...}:hits` key was present in Redis (`DBSIZE` non-zero) immediately after the first post-recovery request — the wrapper's "try primary first, every call" design means there is no sticky fallback state to reset.

## Redis operations

- No writes lost or corrupted during the outage window in either run (nothing was ever queued against Redis while down — every attempted command failed at the connection layer before reaching the server, same as before the fix).
