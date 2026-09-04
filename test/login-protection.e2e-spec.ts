/**
 * FND-008 — account-aware login brute-force protection, container-backed.
 *
 * Real Redis, real Postgres, the REAL AppModule via `createE2eApp` — exactly
 * what a mocked unit suite (`login-protection.service.spec.ts`) structurally
 * cannot prove: that the atomic Lua increment is genuinely exclusive under a
 * real concurrent race, that the TTL invariant (set once, never extended)
 * holds against real Redis, and that expiry actually restores access.
 *
 * MUST be the first import: `AUTH_LOGIN_MAX_FAILED_ATTEMPTS` /
 * `AUTH_LOGIN_LOCKOUT_TTL_SECONDS` must be set before `AppModule` (imported
 * transitively via `createE2eApp`) is ever required in this file's module
 * registry — see login-protection-env.setup.ts for why.
 */
import './utils/login-protection-env.setup';

import { createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { Redis } from 'ioredis';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { AppRedisService } from '../src/queue/app-redis.service';
import { cacheKeyPrefix } from '../src/queue/queue.constants';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { User } from '../src/entities/Auth&RBAC/User';
import { TenantApprovalStatus } from '../src/entities/enums';

const API = '/api/v1';
const THRESHOLD = Number(process.env.AUTH_LOGIN_MAX_FAILED_ATTEMPTS); // 3 (env-setup)
const TTL_SECONDS = Number(process.env.AUTH_LOGIN_LOCKOUT_TTL_SECONDS); // 3 (env-setup)

/** Mirrors LoginProtectionService's private key derivation exactly. */
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
      name: `E2E Login Protection ${suffix}`,
      slug: `e2e-login-${suffix}`,
      contact_email: `e2e-login-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );

  const email = `login-${suffix}@example.test`;
  const password_hash = await bcrypt.hash(password, 4); // low cost factor — speed, not security, in tests
  await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email,
      full_name: `E2E Login User ${suffix}`,
      is_active: true,
      password_hash,
    }),
  );

  return { tenantId: tenant.id, email };
}

async function cleanupLoginTenant(e2e: E2eApp, tenantId: string): Promise<void> {
  // No FK from audit_logs to this tenant: login-protection audit rows are
  // written with tenant=null (login is @Public — there is no authenticated
  // actor to attribute a failed attempt to). Nothing extra to clear here.
  await cleanupTenant(e2e, tenantId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Account-aware login brute-force protection — HTTP e2e (FND-008)', () => {
  let e2e: E2eApp;
  let redis: Redis;

  beforeAll(async () => {
    e2e = await createE2eApp();
    redis = e2e.app.get(AppRedisService).rateLimiter;
  });

  afterAll(async () => {
    // Best-effort cleanup of every tenant this suite created, matched by the
    // "e2e-login-" slug prefix used above. Must run BEFORE the app (and its
    // DataSource) closes.
    const rows: { id: string }[] = await e2e.dataSource.query(
      `SELECT id FROM tenants WHERE slug LIKE 'e2e-login-%'`,
    );
    for (const row of rows) {
      await cleanupLoginTenant(e2e, row.id);
    }
    await e2e.app.close();
  });

  it('sanity: the configured threshold/TTL are the short test values, not the production defaults', () => {
    expect(THRESHOLD).toBe(3);
    expect(TTL_SECONDS).toBe(2);
  });

  it('the Nth wrong-password attempt is refused with RATE_LIMITED once the threshold is reached', async () => {
    const { email } = await createLoginableUser(e2e, 'threshold', 'correct-horse-battery-staple');

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

  it('N concurrent failed attempts against one identity advance the counter by EXACTLY N — real atomicity, not asserted from a mock', async () => {
    const { email } = await createLoginableUser(e2e, 'concurrency', 'correct-horse-battery-staple');
    const key = redisKeyFor(email);
    const N = 8; // deliberately > THRESHOLD, to prove no lost/double increments even past lockout

    await Promise.all(
      Array.from({ length: N }, () =>
        request(e2e.app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password' }),
      ),
    );

    // Every one of the N concurrent requests raced isLocked() at count=0 and
    // reached recordFailure() — so the counter must land at EXACTLY N. A lost
    // increment (non-atomic INCR) would show < N; a double count would show > N.
    const finalCount = await redis.get(key);
    expect(Number(finalCount)).toBe(N);
  });

  it('the key ALWAYS carries a positive TTL immediately after the first failure — a TTL-less key is a permanent lockout', async () => {
    const { email } = await createLoginableUser(e2e, 'ttl-exists', 'correct-horse-battery-staple');
    const key = redisKeyFor(email);

    await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: 'wrong-password' });

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TTL_SECONDS);
  });

  it('the TTL is set ONCE and is NEVER extended by later failures — this is the no-permanent-lockout guarantee', async () => {
    const { email } = await createLoginableUser(e2e, 'ttl-never-extends', 'correct-horse-battery-staple');
    const key = redisKeyFor(email);

    await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: 'wrong-password' });
    const ttlAfterFirst = await redis.ttl(key);
    expect(ttlAfterFirst).toBeGreaterThan(0);

    await sleep(900); // let real time pass so a wrongly-refreshed TTL would be visibly higher

    await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: 'wrong-password' });
    const ttlAfterSecond = await redis.ttl(key);

    // A sliding window (refreshed on every failure) would show ttlAfterSecond
    // approximately equal to the ORIGINAL full TTL_SECONDS again. A fixed
    // window anchored at the first failure can only ever show a SMALLER
    // remaining value here — never equal to or greater than the first read.
    expect(ttlAfterSecond).toBeLessThan(ttlAfterFirst);
    expect(ttlAfterSecond).toBeGreaterThan(0);
  });

  it('protection expires automatically and the correct password then succeeds — no operator action, no permanent lockout', async () => {
    const password = 'correct-horse-battery-staple';
    const { email } = await createLoginableUser(e2e, 'expiry', password);

    for (let i = 0; i < THRESHOLD; i++) {
      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
    }
    const lockedRes = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password });
    expect(lockedRes.status).toBe(429); // even the CORRECT password is refused while locked

    await sleep((TTL_SECONDS + 1) * 1000);

    const recoveredRes = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password });
    expect(recoveredRes.status).toBe(200);
  }, 15000);

  it('a successful login fully clears the failure state — the key is gone afterwards', async () => {
    const password = 'correct-horse-battery-staple';
    const { email } = await createLoginableUser(e2e, 'clears', password);
    const key = redisKeyFor(email);

    await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: 'wrong-password' });
    expect(Number(await redis.get(key))).toBe(1);

    const successRes = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password });
    expect(successRes.status).toBe(200);

    const afterSuccess = await redis.get(key);
    expect(afterSuccess).toBeNull();
  });

  it('an unknown account and a real (but locked) account receive an IDENTICAL refusal — no enumeration oracle', async () => {
    const { email } = await createLoginableUser(e2e, 'parity', 'correct-horse-battery-staple');
    const unknownEmail = `ghost-${Date.now()}@example.test`;

    for (let i = 0; i < THRESHOLD; i++) {
      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: unknownEmail, password: 'whatever' });
    }
    const unknownRes = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email: unknownEmail, password: 'whatever' });

    for (let i = 0; i < THRESHOLD; i++) {
      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'wrong-password' });
    }
    const knownRes = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: 'wrong-password' });

    expect(unknownRes.status).toBe(429);
    expect(knownRes.status).toBe(429);
    // Compare the meaningful response fields — requestId and timestamp are
    // legitimately unique per HTTP call and are not part of the "identical
    // shape" contract (SR-003): the caller-observable outcome (status,
    // error code, message, error name) must be indistinguishable.
    expect(unknownRes.body.statusCode).toEqual(knownRes.body.statusCode);
    expect(unknownRes.body.code).toEqual(knownRes.body.code);
    expect(unknownRes.body.message).toEqual(knownRes.body.message);
    expect(unknownRes.body.error).toEqual(knownRes.body.error);
  });

  it('varying tenantSlug does NOT create a fresh bucket — the identity is the email alone', async () => {
    const { email } = await createLoginableUser(e2e, 'tenant-slug', 'correct-horse-battery-staple');
    const key = redisKeyFor(email);

    await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: 'wrong-password', tenantSlug: 'some-nonexistent-clinic-a' });
    await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: 'wrong-password', tenantSlug: 'some-nonexistent-clinic-b' });

    // Both attempts, despite carrying different (bogus) tenantSlug values,
    // must have incremented the SAME counter — proving the key is derived
    // from the email alone and cannot be evaded by rotating the slug.
    const count = await redis.get(key);
    expect(Number(count)).toBe(2);
  });
});
