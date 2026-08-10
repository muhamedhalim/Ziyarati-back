# PERF-CACHE-001 — Before-fix measurement (T147, 2026-08-10)

Isolated `LOCAL`/T1 stack (`ziyarati-perfaudit-postgres`:5434, `ziyarati-perfaudit-redis`:6380), unmodified `dist/` (pre-fix source), API on port 3001.

## Normal Redis operation

- `harness-normal-before-fix.json`: public readiness p50=15.1ms/p95=40.9ms/p99=96.3ms (20 samples); authenticated `/api/v1/branches` p50=35.3ms/p95=57.5ms/p99=62.8ms (20 samples, all 200); 401 confirmed (no credentials); 403 confirmed (CSRF token missing on POST); login success 200 (922.9ms — first-request bcrypt/JIT cold cost, consistent with prior sessions' notes); login intentional failure 401; 15-concurrent public-route burst — 15/15 200, totalMs=97.8ms.
- 429 burst (`GET /api/v1/whatsapp/webhooks/verify`, 60/min route budget): 60×403 (expected — unauth verification failure, reaches the controller) then 429 from request 61 onward. Confirms the throttle's own admission decision is correct and reachable under normal operation.

## Real Redis outage (container stopped, ~20s window, same procedure as T080)

`harness-during-outage-before-fix.json` — **every scenario 500s**, all in <80ms (fails fast, never hangs):
- Public readiness: 20/20 → 500, `Error: Stream isn't writeable and enableOfflineQueue options is false`, thrown at `ThrottlerStorageRedisService.increment` → `ThrottlerGuard.handleRequest`.
- Unauthenticated `/api/v1/branches`: 500 (same error), not the expected 401.
- Login (correct credentials): 500 — **login is completely broken during a Redis outage today**, not merely rate-limiting; a real user with valid credentials cannot authenticate at all.
- Login (wrong password): 500 — indistinguishable from the correct-credentials case; `LoginProtectionService` is never reached (the request never gets past `ThrottlerGuard`).
- 15-concurrent public-route burst: 15/15 → 500, totalMs=77.6ms — confirms the failure is instantaneous under concurrency too, not a hang/timeout.

Raw response bodies captured via direct `curl` (see conversation transcript) byte-match T080's original evidence (`reports/cache-fail-open-closed.md`) — same error message, same stack, same guard.

## CPU (100-request burst during outage, `Get-Process -Id <api pid>`, matches PERF-BE-003's methodology)

- Before burst: 15.921875 CPU-s. After 100 requests: 16.609375 CPU-s. Delta 0.6875s / 100 req = **~6.9ms/request** while every request 500s at the guard layer (cheap failure — no DB/business-logic work reached).

## Recovery (container restarted, polling `GET /system/health/readiness` every 200ms)

- **Self-recovery confirmed, no app restart required: ~5.2s** from `docker start` to the first clean `200` (matches T080's qualitative finding, now with a measured figure). This is ioredis's own reconnect logic on the `AppRedisService.application` connection — intrinsic to the client, not something T148's fix is expected to change; re-measured after the fix for comparison only.

## Redis operations

- `docker exec ziyarati-perfaudit-redis redis-cli PING` → `PONG` before/after; key count not disturbed by this test (no writes attempted while down — every attempted `INCR`/`EVAL` failed at the connection layer before reaching the server).
