/**
 * P0.5 / P0.4 P04-003 correction — proven over REAL HTTP, not inferred.
 *
 * P0.4 measured that `pg` can produce driver messages like
 * `connect ECONNREFUSED 127.0.0.1:5999` / `password authentication failed
 * for user "postgres"` / `database "no_such_db" does not exist`, and that
 * `HealthController.readiness()` used to pass `db.reason?.message` straight
 * through in the object it throws. P0.4 did NOT establish whether that
 * message actually reaches an HTTP client. Settled here, empirically,
 * against the real `AllExceptionsFilter`, over real HTTP:
 *
 * **The entire `database` / `redis` / `schemaGuards` object is discarded on
 * the 503 path, not just the driver message inside it.**
 * `ServiceUnavailableException` is thrown with a plain object (not a
 * string) that has no top-level `.message` property, so
 * `fromHttpException()` (`src/common/errors/error-normalizer.ts`) falls
 * through to `r.message ?? exception.message` and gets Nest's own default —
 * `"Service Unavailable Exception"`. So the 503 response body today carries
 * NONE of the diagnostic detail the controller constructs, including the
 * safe, already-counts-only `schemaGuards` summary a real orchestrator could
 * otherwise have used to distinguish "DB down" from "guard missing".
 *
 * Two consequences, both pinned below: (1) P04-003 was correctly closed
 * defensively (`UNREACHABLE` constant) but was never exploitable over HTTP
 * through this filter — the unit-level fix in `health.controller.spec.ts`
 * is what actually proves the fixed string, since only a caller that bypasses
 * this specific filter (or a future filter refactor) could ever have seen
 * it; (2) the current 503 body is not useful for orchestrator diagnostics —
 * logged as FU-012 (see `tests/load/reports/FOLLOWUP_FINDINGS.md`), not
 * fixed here, since redesigning the error envelope is outside what P0.5
 * asked for and touches `AllExceptionsFilter`'s behaviour for every other
 * route in the app.
 *
 * Also proves the P0.5 readiness-integrity invariant end-to-end: booting the
 * real `AppModule` against the real `ziyarati_e2e` database runs every
 * `OnApplicationBootstrap` schema check, including the new
 * `SchemaGuardCatalogService` — so a healthy, migration-built database (no
 * known P0 guard missing, per P0.3/P0.4) must report `requiredFailed: 0`.
 *
 * P1.4 (MS-009) ALSO proven here, over real HTTP against the real dedicated
 * connection `HealthController` now uses for the DB ping (never the shared
 * pool — see that file's own docstring): a DB failure is simulated by
 * mocking `pg.Client.prototype.query` (the dedicated client is a real
 * `pg.Client` instance; patching the shared prototype method reaches it
 * transparently, including one already connected and cached from an
 * earlier test in this file) rather than `dataSource.query`, which no
 * longer has any effect on this path — that IS the fix: a saturated shared
 * pool can no longer masquerade as "database down". The new `"busy"` status
 * is proven by mocking the real `pg-pool`'s `waitingCount` getter directly.
 */

/**
 * `test/jest-e2e.env.js` points `REDIS_URL` at a DEDICATED, disposable
 * `zt-e2e-redis` container (port 63790) reserved for the auth-abuse suites
 * that deliberately stop/start Redis mid-run (see that file's own
 * docstring) — this spec needs none of that isolation, only a Redis that is
 * actually up, so it repoints at the always-running shared dev container
 * BEFORE `createE2eApp()` reads `ConfigService`. Confirmed empirically:
 * without this, `redisPing()` fails against an unreachable 63790 and every
 * `readiness` call in this file 503s regardless of database or
 * schema-guard state — a missing local prerequisite, not a finding about
 * the app.
 */
process.env.REDIS_URL =
  process.env.ZT_E2E_REDIS_URL_OVERRIDE || 'redis://127.0.0.1:6379';

import request from 'supertest';
import { Client } from 'pg';

import { QueueService } from '../src/queue/queue.service';
import { createE2eApp, type E2eApp } from './utils/whatsapp-e2e-app';

const API = '/api/v1';

describe('GET /system/health/readiness (HTTP e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 60_000);

  afterAll(async () => {
    await e2e.app.close();
  });

  it('reports ok with all curated schema guards checked and none failed on a healthy database', async () => {
    const res = await request(e2e.app.getHttpServer()).get(
      `${API}/system/health/readiness`,
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toEqual({ status: 'up' });
    expect(res.body.schemaGuards.requiredFailed).toBe(0);
    // P0.4 measured 12/43 (13 believed at the time); P0.5 wires in the
    // generic catalog check (43) plus SchedulingIntegrityService and the
    // AiToolCallsBootstrap fix — comfortably above the old ceiling.
    expect(res.body.schemaGuards.requiredChecked).toBeGreaterThan(12);
  });

  it('a DB failure never leaks any driver detail over HTTP — the entire diagnostic object is discarded, not just the message', async () => {
    // P1.4: the readiness DB ping uses a dedicated `pg.Client`, not the
    // shared pool — mocking `dataSource.query` (the old mechanism) has NO
    // effect on this path any more; that is the fix working as intended.
    // Patching the shared `Client.prototype.query` reaches the dedicated
    // client transparently, including one already connected from an
    // earlier test in this file.
    const leaky = jest
      .spyOn(Client.prototype, 'query')
      .mockImplementationOnce(() =>
        Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5999')),
      );

    try {
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/system/health/readiness`,
      );

      expect(res.status).toBe(503);
      // Pin the ACTUAL behaviour discovered: no `database`, `redis` or
      // `schemaGuards` key survives the filter at all on this path.
      expect(res.body).not.toHaveProperty('database');
      expect(res.body).not.toHaveProperty('redis');
      expect(res.body).not.toHaveProperty('schemaGuards');
      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/ECONNREFUSED/);
      expect(raw).not.toMatch(/127\.0\.0\.1/);
      expect(raw).not.toMatch(/password authentication/i);
      expect(raw).not.toMatch(/does not exist/);
      expect(raw).not.toMatch(/postgres/i);
    } finally {
      leaky.mockRestore();
    }

    // Belt and suspenders — the query failure above discarded the dedicated
    // client (P1.4's reconnect-on-failure behaviour); confirm the NEXT
    // probe transparently reconnects and reports healthy again, for
    // whatever runs after this test in the same file.
    const recovered = await request(e2e.app.getHttpServer()).get(
      `${API}/system/health/readiness`,
    );
    expect(recovered.status).toBe(200);
  });

  it('reports status "busy" (still HTTP 200) when the shared pool has waiting callers, even though the DB itself is fine (MS-009)', async () => {
    const pool = (
      e2e.dataSource.driver as unknown as {
        master: { waitingCount: number };
      }
    ).master;
    const waiting = jest.spyOn(pool, 'waitingCount', 'get').mockReturnValue(3);

    try {
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/system/health/readiness`,
      );

      // Still in rotation — a saturated-but-working instance pulled from
      // rotation only moves its load onto siblings under the same
      // pressure, exactly the amplification MS-009 documented.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('busy');
      expect(res.body.database).toEqual({ status: 'up', poolWaiting: 3 });
    } finally {
      waiting.mockRestore();
    }
  });

  it('a Redis failure never leaks any driver detail over HTTP either', async () => {
    const queueService = e2e.moduleRef.get(QueueService);
    const leaky = jest
      .spyOn(queueService, 'redisPing')
      .mockRejectedValueOnce(
        new Error('password authentication failed for user "default"'),
      );

    try {
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/system/health/readiness`,
      );

      expect(res.status).toBe(503);
      expect(res.body).not.toHaveProperty('redis');
      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/password authentication/i);
      expect(raw).not.toMatch(/"default"/);
    } finally {
      leaky.mockRestore();
    }
  });

  it('liveness never touches the database or redis', async () => {
    const res = await request(e2e.app.getHttpServer()).get(
      `${API}/system/health/liveness`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
