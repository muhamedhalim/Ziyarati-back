# Follow-up findings — out of scope, logged not fixed

Issues noticed while executing the Phase 2 remediation that fall outside the
phase's stated scope. Per the execution rules these are recorded, **not fixed**.

---

## FU-001 — `ApiLogService.stats()` runs three unbounded aggregates over `api_logs`

**Severity:** Medium (admin endpoint; degrades as the table grows)
**Found during:** Phase 2.1
**Affected files:** `src/modules/platform/api-log.service.ts` (`stats()`),
`src/modules/platform/api-log.controller.ts`

**Evidence:** `stats()` issues three separate queries over the tenant's entire
`api_logs` history with no time bound: a `COUNT(*)` + `AVG` + filtered `COUNT`,
then `GROUP BY method`, then `GROUP BY status_code`. There is no `created_at`
predicate on any of them, so cost grows linearly with retained history.
`PLATFORM_API_LOG_RETENTION_DAYS` bounds the table, but at the default retention
and a busy tenant this is still a full scan of that tenant's slice per call.
The supporting index is `(tenant, created_at)`, which the aggregates cannot use
for the `GROUP BY`s.

Not measured under load — the endpoint is not part of any k6 scenario.

**Recommended fix:** require a bounded window (`from`/`to`, defaulting to e.g.
30 days) and serve the three aggregates from one pass; consider a rollup table
if per-key metering needs to stay cheap at scale.

---

## FU-002 — Sampling changes the meaning of `stats().totalRequests` for UI traffic

**Severity:** Low (disclosed, not a defect — a consequence of the Phase 2.1 fix)
**Found during:** Phase 2.1
**Affected files:** `src/modules/platform/api-log.service.ts`,
`src/modules/platform/interceptors/api-logging.interceptor.ts`

**Evidence:** with `PLATFORM_API_LOG_SAMPLE < 1` (new production default 0.1),
`totalRequests`/`byMethod`/`byStatus` for ordinary cookie/JWT traffic become a
sample rather than a census. API-key traffic and all `>= 400` responses are
exempt from sampling, so per-key metering and error counts remain exact.

**Recommended fix:** if a census of UI traffic is ever required, source it from
the Prometheus `http_request_*` series (which covers 100% of requests, including
guard-rejected ones) rather than raising the sample rate. Alternatively surface
the effective sample rate alongside the numbers in the stats payload so a
consumer can tell a sample from a census.

---

## FU-003 — `.env` (tracked) carries live third-party credentials

**Severity:** High — **already scheduled as Phase 3.3**, recorded here so it is
not lost if that phase is deferred.
**Affected files:** `Ziyarati-back/.env` (tracked in git)

**Evidence:** the tracked development `.env` contains populated values for
third-party API credentials. Values deliberately not reproduced here or
anywhere in the reports.

**Recommended fix:** treat as compromised — rotate at the provider first, then
remove from tracked files and purge from history. Deleting the line alone does
not undo exposure. Full handling belongs to Phase 3.3.
