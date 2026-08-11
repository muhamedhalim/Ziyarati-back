/**
 * 009-auth-abuse-resistance — ZT-006 register-owner layered abuse bound,
 * HTTP e2e. Boots the REAL AppModule against real (disposable) Postgres +
 * Redis via `createE2eApp`, same infrastructure as the other 009 abuse-bound
 * suites.
 *
 * MUST be the first import: see login-protection-env.setup.ts's docstring
 * for why the fast test values must be set before AppModule is ever
 * required in this file's module registry.
 */
import './utils/auth-abuse-register-owner-env.setup';

import request from 'supertest';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { dockerStop, dockerStart, safely, sleep, waitForRedisReady } from './utils/docker-redis-control';
import { alignToFreshWindow, alignToFreshWindowGuaranteed } from './utils/window-alignment';

const API = '/api/v1';
const IDENTITY_BUDGET = Number(process.env.AUTH_REGISTER_OWNER_MAX_PER_IDENTITY); // 3
const ENDPOINT_CEILING = Number(process.env.AUTH_REGISTER_OWNER_ENDPOINT_CEILING); // 8
const WINDOW_SECONDS = Number(process.env.AUTH_REGISTER_OWNER_WINDOW_SECONDS); // 60
const DEGRADED_ENDPOINT_CEILING = Math.max(
  1,
  Math.ceil(ENDPOINT_CEILING * Number(process.env.AUTH_ABUSE_DEGRADED_FACTOR)),
);

interface OwnerDto {
  email: string;
  password: string;
  fullName: string;
  clinicName: string;
  slug: string;
  commercialRegistrationNumber: string;
}

/** A fully fresh identity on every axis (email, slug, commercialRegistrationNumber) — rotating all three is exactly the attack this endpoint's coarse ceiling exists for. */
function freshIdentity(label: string): OwnerDto {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `owner-${suffix}@example.test`,
    password: 'StrongPass123!',
    fullName: `E2E Owner ${suffix}`,
    clinicName: `E2E Register-Owner Clinic ${suffix}`,
    slug: `e2e-reg-${suffix}`,
    commercialRegistrationNumber: `CR-${suffix}`,
  };
}

function register(e2e: E2eApp, dto: OwnerDto) {
  return request(e2e.app.getHttpServer()).post(`${API}/auth/register-owner`).send(dto);
}

async function tenantSlugsExisting(e2e: E2eApp, slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows: { slug: string }[] = await e2e.dataSource.query(
    `SELECT slug FROM tenants WHERE slug = ANY($1)`,
    [slugs],
  );
  return rows.map((r) => r.slug);
}

describe('Register-owner abuse bound — HTTP e2e (009, ZT-006)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    await waitForRedisReady();
    e2e = await createE2eApp();
  }, 60_000);

  afterAll(async () => {
    safely(dockerStart);
    await sleep(300);
    if (!e2e) return;
    const rows: { id: string }[] = await e2e.dataSource.query(
      `SELECT id FROM tenants WHERE slug LIKE 'e2e-reg-%'`,
    );
    for (const row of rows) {
      await cleanupTenant(e2e, row.id);
    }
    await e2e.app.close();
  }, 60_000);

  beforeEach(async () => {
    await alignToFreshWindow(WINDOW_SECONDS);
  }, 70_000);

  it('sanity: the configured bounds are the test values, not the production defaults', () => {
    expect(IDENTITY_BUDGET).toBe(3);
    expect(ENDPOINT_CEILING).toBe(8);
    expect(WINDOW_SECONDS).toBe(60);
  });

  // ── T096 — golden path ───────────────────────────────────────────────────
  it('T096 a normal single registration still succeeds end-to-end', async () => {
    const dto = freshIdentity('golden');
    const res = await register(e2e, dto);
    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(await tenantSlugsExisting(e2e, [dto.slug])).toEqual([dto.slug]);
  });

  // ── T097/FR-066 — identity layer bounds repeated same-identity attempts ──
  it('T097 repeated same-identity registrations are bounded by the identity layer', async () => {
    const email = freshIdentity('same-identity').email;
    const results: { status: number; slug: string }[] = [];

    for (let i = 0; i < IDENTITY_BUDGET + 3; i++) {
      // Only the email is held constant — slug/commercialRegistrationNumber
      // rotate each attempt so the identity layer's OWN signal (keyed on
      // email alone) is what's being isolated, not a slug/CR clash.
      const dto = { ...freshIdentity(`same-identity-${i}`), email };
      const res = await register(e2e, dto);
      results.push({ status: res.status, slug: dto.slug });
    }

    // Attempt 1: genuinely new identity — succeeds.
    expect(results[0].status).toBe(201);
    // Attempts 2..IDENTITY_BUDGET: identity layer still allows them through
    // (count <= budget), so they reach the pre-existing global email-
    // uniqueness check and fail there — CONFLICT, not RATE_LIMITED. This is
    // what proves the identity layer and the business-logic conflict check
    // are genuinely separate mechanisms.
    for (let i = 1; i < IDENTITY_BUDGET; i++) {
      expect(results[i].status).toBe(409);
    }
    // Attempts past the budget: the identity layer itself now refuses,
    // BEFORE the email-uniqueness check is ever reached.
    for (let i = IDENTITY_BUDGET; i < results.length; i++) {
      expect(results[i].status).toBe(429);
    }
    // No tenant was created for any refused attempt.
    const refusedSlugs = results.filter((r) => r.status === 429).map((r) => r.slug);
    expect(await tenantSlugsExisting(e2e, refusedSlugs)).toEqual([]);
  }, 30_000);

  // ── T098/SC-005c — rotating-identity flood defeats the identity layer ───
  it('T098 a rotating-identity flood is refused at the endpoint ceiling, with no side effect for any refused request', async () => {
    // Deliberately larger than ENDPOINT_CEILING regardless of whatever this
    // shared, non-identity-keyed counter already holds from T096/T097 in
    // this same window (at most 1 + IDENTITY_BUDGET = 4 of ENDPOINT_CEILING
    // = 8) — guarantees crossing the ceiling without depending on exact
    // cross-test bookkeeping.
    const floodSize = ENDPOINT_CEILING + 8;
    const results: { status: number; slug: string; dto: OwnerDto }[] = [];

    for (let i = 0; i < floodSize; i++) {
      const dto = freshIdentity(`flood-${i}`); // every field rotates — defeats BOTH the identity layer and any slug/email-based signal
      const res = await register(e2e, dto);
      results.push({ status: res.status, slug: dto.slug, dto });
    }

    const refused = results.filter((r) => r.status === 429);
    const admitted = results.filter((r) => r.status === 201);
    expect(refused.length).toBeGreaterThan(0); // the ceiling was actually reached within this flood
    expect(admitted.length + refused.length).toBe(floodSize); // every response was one or the other — no unexpected status

    // No tenant, user or provisioning side effect exists for ANY refused slug.
    const refusedSlugs = refused.map((r) => r.slug);
    expect(await tenantSlugsExisting(e2e, refusedSlugs)).toEqual([]);
    // Every ADMITTED slug, conversely, really was provisioned.
    const admittedSlugs = admitted.map((r) => r.slug);
    const existing = await tenantSlugsExisting(e2e, admittedSlugs);
    expect(existing.sort()).toEqual(admittedSlugs.sort());
  }, 60_000);

  // ── T099/FR-017 — concurrency cannot bypass the endpoint ceiling ────────
  it('T099 a concurrent rotating-identity flood cannot bypass the endpoint ceiling', async () => {
    // A guaranteed-fresh window so this test can deterministically drain to
    // exactly one remaining slot before racing for it (the strongest,
    // atomicity-proving shape — same rigor as T064's forgot-password
    // concurrency proof), independent of whatever earlier tests in this
    // file already consumed.
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS);

    for (let i = 0; i < ENDPOINT_CEILING - 1; i++) {
      const dto = freshIdentity(`concurrency-drain-${i}`);
      const res = await register(e2e, dto);
      expect(res.status).toBe(201);
    }

    const concurrentCount = 6;
    const dtos = Array.from({ length: concurrentCount }, (_, i) =>
      freshIdentity(`concurrency-race-${i}`),
    );
    const results = await Promise.all(dtos.map((dto) => register(e2e, dto)));

    const admittedCount = results.filter((r) => r.status === 201).length;
    expect(admittedCount).toBeLessThanOrEqual(1); // at most the single remaining slot, never more

    const refusedSlugs = dtos
      .filter((_, i) => results[i].status !== 201)
      .map((dto) => dto.slug);
    expect(await tenantSlugsExisting(e2e, refusedSlugs)).toEqual([]);
  }, 100_000); // alignToFreshWindowGuaranteed alone can take up to WINDOW_SECONDS (60s) — a too-short timeout here would let Jest move on to the next test while this one is still mid-flight, corrupting whatever that next test measures (observed directly: a 45s timeout here left this test's drain loop running into T100's degraded-mode counter)

  // ── T100/FR-068b — degraded mode, recovery, and window expiry ───────────
  describe('degraded mode (Redis unavailable)', () => {
    // registerOwner dispatches a best-effort welcome email on every success
    // — same pre-existing, out-of-scope BullMQ-producer retry-exhaustion
    // risk as forgot-password's degraded tests when Redis is genuinely
    // stopped mid-suite. EMAIL_SYNC=true (env-setup file) routes it through
    // EmailDeliveryService instead, but this is a belt-and-braces second
    // layer in case any OTHER Redis-backed path independently trips the
    // same failure class.
    const swallowKnownProducerRetryExhaustion = (err: unknown) => {
      const message = (err as Error)?.message ?? String(err);
      if (!/max retries per request/i.test(message)) throw err;
    };

    beforeAll(() => {
      dockerStop();
      process.on('unhandledRejection', swallowKnownProducerRetryExhaustion);
      process.on('uncaughtException', swallowKnownProducerRetryExhaustion);
    });
    afterAll(async () => {
      process.off('unhandledRejection', swallowKnownProducerRetryExhaustion);
      process.off('uncaughtException', swallowKnownProducerRetryExhaustion);
      safely(dockerStart);
      await sleep(1_500);
    });

    it('T100 the bounded local fallback still bounds tenant creation while Redis is down — not effectively unlimited', async () => {
      const floodSize = DEGRADED_ENDPOINT_CEILING + 3;
      const results: { status: number; slug: string }[] = [];
      for (let i = 0; i < floodSize; i++) {
        const dto = freshIdentity(`degraded-${i}`);
        const res = await register(e2e, dto);
        results.push({ status: res.status, slug: dto.slug });
      }
      expect(results.filter((r) => r.status === 201)).toHaveLength(DEGRADED_ENDPOINT_CEILING);
      expect(results.filter((r) => r.status === 429)).toHaveLength(floodSize - DEGRADED_ENDPOINT_CEILING);

      const refusedSlugs = results.filter((r) => r.status === 429).map((r) => r.slug);
      expect(await tenantSlugsExisting(e2e, refusedSlugs)).toEqual([]);
    }, 45_000);
  });

  it('T100 after Redis recovers, enforcement resumes on the real Redis-backed ceiling — including a legitimate registration succeeding in the fresh window', async () => {
    dockerStop();
    try {
      for (let i = 0; i < DEGRADED_ENDPOINT_CEILING; i++) {
        await register(e2e, freshIdentity(`recovery-drain-${i}`));
      }
      const stillDegraded = await register(e2e, freshIdentity('recovery-still-degraded'));
      expect(stillDegraded.status).toBe(429);
    } finally {
      safely(dockerStart);
    }
    await sleep(1_500);
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS);

    const postRecoveryResults: { status: number; slug: string }[] = [];
    for (let i = 0; i < ENDPOINT_CEILING + 2; i++) {
      const dto = freshIdentity(`recovery-${i}`);
      const res = await register(e2e, dto);
      postRecoveryResults.push({ status: res.status, slug: dto.slug });
    }
    // A precise, real Redis-backed ceiling — not the looser degraded one,
    // and not permanently exhausted — is back in force in the fresh window.
    expect(postRecoveryResults.filter((r) => r.status === 201)).toHaveLength(ENDPOINT_CEILING);
    expect(postRecoveryResults.filter((r) => r.status === 429)).toHaveLength(2);
  }, 180_000); // DEGRADED_ENDPOINT_CEILING+1 requests against a stopped Redis (~2.3s Redis-timeout each) + up to WINDOW_SECONDS (60s) alignment wait + the post-recovery flood — see T099's identical reasoning for why this must not be tight
});
