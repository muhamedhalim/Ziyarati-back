/**
 * 009-auth-abuse-resistance — ZT-002 Redis degradation and recovery, HTTP
 * e2e. Boots the REAL AppModule against real (disposable) Postgres + Redis
 * via `createE2eApp`, then genuinely stops/pauses/starts the DISPOSABLE
 * Redis container to exercise the degraded-mode fallback and automatic
 * recovery paths a mocked unit suite cannot prove.
 *
 * **Infrastructure rule (FR-058)**: this file stops and restarts a REAL
 * Redis container. It MUST be pointed at the disposable `zt-e2e-redis`
 * container (see specs/009-auth-abuse-resistance/quickstart.md §0/§6/§7),
 * NEVER the shared development Redis. The container name is read from
 * `ZT_E2E_REDIS_CONTAINER` (default `zt-e2e-redis`) so a differently-named
 * disposable container can be substituted without editing this file.
 * `afterAll` guarantees the container is left running (started, unpaused)
 * even if an assertion above it throws, so later e2e files in the same run
 * are never left without Redis.
 *
 * MUST be the first import: see login-protection-env.setup.ts's docstring
 * for why AUTH_LOGIN_MAX_FAILED_ATTEMPTS/AUTH_LOGIN_LOCKOUT_TTL_SECONDS must
 * be set before AppModule is ever required in this file's module registry.
 */
import './utils/auth-abuse-degradation-env.setup';

import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Redis } from 'ioredis';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { dockerStop, dockerStart, dockerPause, dockerUnpause, safely, sleep, waitForRedisReady } from './utils/docker-redis-control';
import { AppRedisService } from '../src/queue/app-redis.service';
import { cacheKeyPrefix } from '../src/queue/queue.constants';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { User } from '../src/entities/Auth&RBAC/User';
import { TenantApprovalStatus } from '../src/entities/enums';

const API = '/api/v1';
const THRESHOLD = Number(process.env.AUTH_LOGIN_MAX_FAILED_ATTEMPTS); // 3
const TTL_SECONDS = Number(process.env.AUTH_LOGIN_LOCKOUT_TTL_SECONDS); // 2
const DEGRADED_THRESHOLD = Math.max(
  1,
  Math.ceil(THRESHOLD * Number(process.env.AUTH_ABUSE_DEGRADED_FACTOR)), // ceil(3 * 0.5) = 2
);

/** Mirrors LoginProtectionService's private key derivation exactly (same as login-protection.e2e-spec.ts). */
function redisKeyFor(email: string): string {
  const normalized = email.trim().toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `${cacheKeyPrefix()}auth:login:fail:${hash}`;
}

async function createLoginableUser(
  e2e: E2eApp,
  label: string,
  password: string,
): Promise<{ tenantId: string; email: string }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenants = e2e.dataSource.getRepository(Tenant);
  const users = e2e.dataSource.getRepository(User);

  const tenant = await tenants.save(
    tenants.create({
      name: `E2E Degradation ${suffix}`,
      slug: `e2e-degrade-${suffix}`,
      contact_email: `e2e-degrade-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );

  const email = `degrade-${suffix}@example.test`;
  const password_hash = await bcrypt.hash(password, 4); // low cost factor — speed, not security, in tests
  await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email,
      full_name: `E2E Degradation User ${suffix}`,
      is_active: true,
      password_hash,
    }),
  );

  return { tenantId: tenant.id, email };
}

describe('Redis degradation and recovery — HTTP e2e (009, ZT-002)', () => {
  let e2e: E2eApp;
  let redis: Redis;

  beforeAll(async () => {
    // Robust against running directly after another suite that stopped/
    // paused this same disposable container.
    await waitForRedisReady();
    e2e = await createE2eApp();
    redis = e2e.app.get(AppRedisService).rateLimiter;
  }, 60_000);

  afterAll(async () => {
    // Belt-and-braces: guarantee the disposable Redis container is left
    // running and unpaused, even if a test above threw mid-way — later e2e
    // files in the same test run depend on it.
    safely(dockerUnpause);
    safely(dockerStart);
    await sleep(300); // let ioredis's own retryStrategy reconnect before closing the app

    // Matched by the "e2e-degrade-" slug prefix used by createLoginableUser,
    // same pattern as login-protection.e2e-spec.ts's own afterAll.
    const rows: { id: string }[] = await e2e.dataSource.query(
      `SELECT id FROM tenants WHERE slug LIKE 'e2e-degrade-%'`,
    );
    for (const row of rows) {
      await cleanupTenant(e2e, row.id);
    }
    await e2e.app.close();
  }, 30_000);

  it('sanity: degraded threshold is derived correctly from the configured factor', () => {
    expect(THRESHOLD).toBe(3);
    expect(DEGRADED_THRESHOLD).toBe(2);
  });

  // ── T047 — Redis healthy: existing lockout behaviour intact (SC-008 baseline) ──
  describe('Redis healthy (baseline)', () => {
    it('the Nth wrong-password attempt is still refused with RATE_LIMITED once the healthy threshold is reached', async () => {
      const { email } = await createLoginableUser(e2e, 'healthy', 'correct-horse-battery-staple');
      for (let i = 0; i < THRESHOLD; i++) {
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password' });
        expect(res.status).toBe(401);
      }
      const lockedRes = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
      expect(lockedRes.status).toBe(429);
    });
  });

  // ── T048/T049/T050/T051 — Redis unavailable: degraded mode ──────────────
  describe('Redis unavailable (degraded mode)', () => {
    beforeAll(() => {
      dockerStop();
    });

    afterAll(() => {
      safely(dockerStart);
    });

    it('T048 failures against one identity beyond the degraded threshold are refused — currently unlimited before this feature', async () => {
      const { email } = await createLoginableUser(e2e, 'degraded-threshold', 'correct-horse-battery-staple');

      for (let i = 0; i < DEGRADED_THRESHOLD; i++) {
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password' });
        expect(res.status).toBe(401);
      }
      const shouldBeBlocked = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
      expect(shouldBeBlocked.status).toBe(429);
    });

    it('T049 a user with correct credentials and NO failure history authenticates on the first attempt while degraded', async () => {
      const password = 'correct-horse-battery-staple';
      const { email } = await createLoginableUser(e2e, 'degraded-fresh', password);

      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password });
      expect(res.status).toBe(200);
    });

    it('T050 concurrent failed logins in degraded mode advance the local count by exactly N — no lost increments through a read-then-write race', async () => {
      const { email } = await createLoginableUser(e2e, 'degraded-concurrency', 'correct-horse-battery-staple');

      // Exactly DEGRADED_THRESHOLD concurrent failures. If even one
      // increment were lost to a race, the local count would land BELOW
      // DEGRADED_THRESHOLD and the follow-up request would still succeed in
      // reaching invalid-credentials (401) instead of being refused (429).
      await Promise.all(
        Array.from({ length: DEGRADED_THRESHOLD }, () =>
          request(e2e.app.getHttpServer())
            .post(`${API}/auth/login`)
            .send({ email, password: 'wrong-password' }),
        ),
      );

      const followUp = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
      expect(followUp.status).toBe(429);
    });

    it('T051 degraded lockout expires on its own — no permanent process-local lockout', async () => {
      const { email } = await createLoginableUser(e2e, 'degraded-expiry', 'correct-horse-battery-staple');

      for (let i = 0; i < DEGRADED_THRESHOLD; i++) {
        await request(e2e.app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password' });
      }
      const lockedRes = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
      expect(lockedRes.status).toBe(429);

      // Two full windows so both generations (current + previous) age out —
      // see BoundedLocalCounter's lazy rotation.
      await sleep((TTL_SECONDS * 2 + 1) * 1000);

      const afterExpiry = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
      expect(afterExpiry.status).toBe(401); // back to ordinary invalid-credentials, not 429
    }, 20_000);

    it('T054 bounded log volume during a sustained degraded burst, with no sensitive value in any captured line', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();
      const { email } = await createLoginableUser(e2e, 'degraded-log-volume', 'correct-horse-battery-staple');

      for (let i = 0; i < 30; i++) {
        await request(e2e.app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password' });
      }

      // Scope to LoginProtectionService's own degraded-mode lines specifically
      // — Logger.prototype.warn is process-wide, so an unscoped spy also
      // picks up unrelated pre-existing Redis-dependent logging elsewhere in
      // this large app (BullMQ producer/worker reconnection chatter etc.),
      // none of which this feature touches or is responsible for bounding.
      // What FR-035/SC-012 requires bounded is the SPECIFIC per-request
      // warning this feature replaces (DegradedModeLogLimiter's "entering
      // degraded mode"/"still degraded" lines), not the app's total log
      // volume from every subsystem during a Redis outage.
      const loginProtectionCalls = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('Login protection store'),
      );
      // 30 requests through a degraded store — by this point the service was
      // ALREADY in degraded mode from earlier tests in this describe block
      // (state persists on the singleton, matching production), so this
      // burst should add few or zero NEW lines, never one per request.
      expect(loginProtectionCalls.length).toBeLessThan(5);

      // No-sensitive-value check is scoped to THIS feature's own logging
      // (the lines just asserted bounded above), not the whole app's log
      // output — an unscoped app-wide spy also captures unrelated,
      // pre-existing, already-safe logging (e.g. the API request logger's
      // `"password":"[REDACTED]"` field NAME, which legitimately contains
      // the word "password" with a redacted, non-sensitive value; verifying
      // that interceptor's own redaction is a different, already-covered
      // concern outside this feature's touched files).
      const loginProtectionText = loginProtectionCalls.map((c) => String(c[0])).join('\n');
      expect(loginProtectionText).not.toContain(email);
      expect(loginProtectionText).not.toMatch(/correct-horse-battery-staple/);
      expect(loginProtectionText).not.toMatch(/password/i);
      warnSpy.mockRestore();
    });
  });

  // ── T052 — Redis recovers ────────────────────────────────────────────────
  describe('Redis recovery', () => {
    it('T052 after Redis returns, the next decision for a previously-degraded identity is served by Redis, with no residual local lockout — no API restart', async () => {
      const { email } = await createLoginableUser(e2e, 'recovery', 'correct-horse-battery-staple');
      const key = redisKeyFor(email);

      dockerStop();
      try {
        // Lock the identity out under degraded mode.
        for (let i = 0; i < DEGRADED_THRESHOLD; i++) {
          await request(e2e.app.getHttpServer())
            .post(`${API}/auth/login`)
            .send({ email, password: 'wrong-password' });
        }
        const stillDegraded = await request(e2e.app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password' });
        expect(stillDegraded.status).toBe(429);
      } finally {
        safely(dockerStart);
      }

      // Give ioredis's retryStrategy a moment to reconnect (no app restart).
      await sleep(1_500);

      // Redis's OWN counter for this identity was never touched while it was
      // down (nothing was written there), so the very next decision — made
      // by Redis, not by any leftover local state — must NOT be locked.
      const afterRecovery = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
      expect(afterRecovery.status).toBe(401); // not 429 — no residual local lockout overriding healthy Redis

      const redisCount = await redis.get(key);
      // Exactly one failure recorded in Redis (the afterRecovery attempt) —
      // proves Redis, not stale local state, is authoritative again.
      expect(Number(redisCount)).toBe(1);
    }, 20_000);
  });

  // ── T053 — slow (not down) Redis degrades within the existing bound ─────
  describe('Redis slow (not unavailable)', () => {
    it('T053 a paused (unresponsive, not stopped) Redis degrades within the existing commandTimeout bound rather than hanging', async () => {
      const { email } = await createLoginableUser(e2e, 'slow', 'correct-horse-battery-staple');

      dockerPause();
      try {
        const startedAt = Date.now();
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password' });
        const elapsedMs = Date.now() - startedAt;

        expect(res.status).toBe(401); // degraded fallback still makes a decision
        // rateLimiter's commandTimeout is 2000ms; two sequential calls
        // (isLocked then recordFailure) bound this at ~4s, well under a
        // request being held open indefinitely.
        expect(elapsedMs).toBeLessThan(8_000);
      } finally {
        safely(dockerUnpause);
      }
    }, 15_000);
  });
});
