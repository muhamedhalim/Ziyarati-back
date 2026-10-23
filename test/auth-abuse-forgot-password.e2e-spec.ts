/**
 * 009-auth-abuse-resistance — ZT-006 forgot-password abuse bound, HTTP e2e.
 * Boots the REAL AppModule against real (disposable) Postgres + Redis via
 * `createE2eApp`. ZT-010 (User Story 1 — tenant recovery) tests are added to
 * this SAME file in Phase 6, per tasks.md's file layout.
 *
 * MUST be the first import: see login-protection-env.setup.ts's docstring
 * for why AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW/_WINDOW_SECONDS must be set
 * before AppModule is ever required in this file's module registry.
 */
import './utils/auth-abuse-forgot-password-env.setup';

import { Logger } from '@nestjs/common';
import request from 'supertest';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { dockerStop, dockerStart, safely, sleep, waitForRedisReady } from './utils/docker-redis-control';
import { alignToFreshWindow } from './utils/window-alignment';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { User } from '../src/entities/Auth&RBAC/User';
import { TenantApprovalStatus } from '../src/entities/enums';

const API = '/api/v1';
const BUDGET = Number(process.env.AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW); // 5
const WINDOW_SECONDS = Number(process.env.AUTH_FORGOT_PASSWORD_WINDOW_SECONDS); // 3
const DEGRADED_BUDGET = Math.max(
  1,
  Math.ceil(BUDGET * Number(process.env.AUTH_ABUSE_DEGRADED_FACTOR)), // ceil(5 * 0.5) = 3
);
const GENERIC_MESSAGE = 'If that email is registered, a reset link has been sent.';

async function createRecoverableUser(
  e2e: E2eApp,
  label: string,
): Promise<{ tenantId: string; tenantSlug: string; email: string }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenants = e2e.dataSource.getRepository(Tenant);
  const users = e2e.dataSource.getRepository(User);

  const slug = `e2e-forgot-${suffix}`;
  const tenant = await tenants.save(
    tenants.create({
      name: `E2E Forgot-Password ${suffix}`,
      slug,
      contact_email: `e2e-forgot-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );

  const email = `forgot-${suffix}@example.test`;
  await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email,
      full_name: `E2E Forgot-Password User ${suffix}`,
      is_active: true,
      password_hash: 'irrelevant-not-used-by-forgot-password',
    }),
  );

  return { tenantId: tenant.id, tenantSlug: slug, email };
}

/** ZT-010 — a platform super-admin: a live user row with NO tenant at all. */
async function createSuperAdminUser(e2e: E2eApp, label: string): Promise<{ email: string }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users = e2e.dataSource.getRepository(User);
  const email = `super-admin-${suffix}@example.test`;
  await users.save(
    users.create({
      // No `tenant` on purpose: a platform super-admin row has tenantId NULL.
      email,
      full_name: `E2E Super Admin ${suffix}`,
      is_active: true,
      password_hash: 'irrelevant-not-used-by-forgot-password',
    }),
  );
  return { email };
}

function unknownEmail(label: string): string {
  return `ghost-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function passwordResetCountFor(e2e: E2eApp, email: string): Promise<number> {
  // password_resets has no email column — join through the user.
  const rows: { count: string }[] = await e2e.dataSource.query(
    `SELECT count(*)::text AS count FROM password_resets pr
     JOIN users u ON u.id = pr."userId"
     WHERE u.email = $1`,
    [email.trim().toLowerCase()],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Counts every dispatch attempt recorded for `email` in `email_logs`
 * (written by EmailDeliveryService.sendAndRecord regardless of whether
 * delivery went through the queue or — as this suite forces via
 * EMAIL_SYNC=true, see the env-setup file — inline). More direct than
 * checking BullMQ queue depth: proves an actual send was ATTEMPTED, not
 * just that a job was enqueued.
 */
async function emailLogCountFor(e2e: E2eApp, email: string): Promise<number> {
  const rows: { count: string }[] = await e2e.dataSource.query(
    `SELECT count(*)::text AS count FROM email_logs WHERE to_address = $1`,
    [email.trim().toLowerCase()],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('Forgot-password abuse bound — HTTP e2e (009, ZT-006)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    // Robust against running directly after another suite that stopped/
    // paused this same disposable container (see waitForRedisReady's own
    // docstring) — a fixed short sleep is not always enough.
    await waitForRedisReady();
    e2e = await createE2eApp();
  }, 60_000);

  afterAll(async () => {
    safely(dockerStart); // belt-and-braces in case a degraded-mode test below left Redis stopped
    await sleep(300);
    if (!e2e) return; // beforeAll never completed — nothing to clean up
    const rows: { id: string }[] = await e2e.dataSource.query(
      `SELECT id FROM tenants WHERE slug LIKE 'e2e-forgot-%'`,
    );
    for (const row of rows) {
      await cleanupTenant(e2e, row.id);
    }
    await e2e.app.close();
  }, 30_000);

  // See window-alignment.ts's docstring: keeps every same-subject burst
  // below clear of a real 60-second calendar-window boundary so "exactly
  // BUDGET admitted" assertions can't be spuriously split across two windows.
  beforeEach(async () => {
    await alignToFreshWindow(WINDOW_SECONDS);
  }, 70_000);

  it('sanity: the configured budget/window are the test values, not the production defaults', () => {
    expect(BUDGET).toBe(5);
    expect(WINDOW_SECONDS).toBe(60); // the schema's own floor — see the env-setup file's docstring
    expect(DEGRADED_BUDGET).toBe(3);
  });

  // ── T059/SC-003 ──────────────────────────────────────────────────────────
  it('T059 a 20-request burst yields at most the budget accepted, the remainder refused with 429', async () => {
    const { email } = await createRecoverableUser(e2e, 'burst');
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email });
      statuses.push(res.status);
    }
    const okCount = statuses.filter((s) => s === 200).length;
    const refusedCount = statuses.filter((s) => s === 429).length;
    expect(okCount).toBe(BUDGET);
    expect(refusedCount).toBe(20 - BUDGET);
  });

  // ── T060/SC-004 ───────────────────────────────────────────────────────────
  it('T060 the burst produces at most the budget worth of password_resets rows and dispatched messages, not 20', async () => {
    const { email } = await createRecoverableUser(e2e, 'side-effect');

    for (let i = 0; i < 20; i++) {
      await request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email });
    }

    const rowCount = await passwordResetCountFor(e2e, email);
    const sentCount = await emailLogCountFor(e2e, email);
    expect(rowCount).toBeLessThanOrEqual(BUDGET);
    expect(sentCount).toBeLessThanOrEqual(BUDGET);
  });

  // ── T061/SC-005 — anti-enumeration ───────────────────────────────────────
  it('T061 matched bursts against a registered and an unregistered address are identical at every position — status, body, shape, headers', async () => {
    const { email: registered } = await createRecoverableUser(e2e, 'enum-known');
    const unregistered = unknownEmail('enum-unknown');

    const runBurst = async (targetEmail: string) => {
      // ZT-FINAL-001 — align per BURST, not once per test.
      //
      // The two bursts below target DIFFERENT addresses, so they consume two
      // INDEPENDENT limiter keys, each with its own BUDGET-per-window counter.
      // The assertion is about the POSITION of the first 429, which only holds
      // if each burst observes exactly one window: a burst that straddles a
      // 60-second boundary has its own counter reset mid-flight, so more than
      // BUDGET succeed and its first 429 lands later (or never) than the
      // other's — the two `findIndex` values then differ and this test fails,
      // reporting an "enumeration difference" that is really a clock artifact.
      //
      // The file-level `beforeEach` alignment is not sufficient here: it runs
      // ONCE, before `createRecoverableUser` and before BOTH bursts, and its
      // default 10-second margin was sized for the single-burst tests above.
      // This test issues 2 × (BUDGET + 3) = 16 sequential HTTP requests plus a
      // user creation inside one test body, which under heavy machine load
      // exceeds that margin — the observed intermittent failure (a 5-suite
      // subset failed while the same file alone, and the full 33-suite run,
      // both passed). Re-aligning at the start of each burst, with a margin
      // that comfortably covers one burst, makes the assertion structurally
      // independent of how slowly the process happens to be running.
      //
      // This changes only WHEN the requests are issued. The security property
      // under test — that a registered and an unregistered address are
      // indistinguishable at every position — is asserted exactly as before.
      await alignToFreshWindow(WINDOW_SECONDS, 30);

      const results: { status: number; body: unknown; headers: Record<string, unknown> }[] = [];
      for (let i = 0; i < BUDGET + 3; i++) {
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/auth/forgot-password`)
          .send({ email: targetEmail });
        const { date, 'x-request-id': _rid, ...headers } = res.headers;
        // requestId/timestamp are legitimately unique per HTTP call (same
        // convention as the existing login-protection e2e's own comparison)
        // — not part of the "identical shape" contract.
        const { requestId: _reqId, timestamp: _ts, ...body } = (res.body ?? {}) as Record<string, unknown>;
        results.push({ status: res.status, body, headers });
      }
      return results;
    };

    const knownResults = await runBurst(registered);
    const unknownResults = await runBurst(unregistered);

    expect(knownResults.map((r) => r.status)).toEqual(unknownResults.map((r) => r.status));
    // Position where 429 first appears must match exactly.
    expect(knownResults.findIndex((r) => r.status === 429)).toBe(
      unknownResults.findIndex((r) => r.status === 429),
    );
    for (let i = 0; i < knownResults.length; i++) {
      expect(knownResults[i].body).toEqual(unknownResults[i].body);
      // The pre-existing APP-WIDE throttle guard (unrelated to this
      // endpoint's own bound, unmodified by 009) sets X-RateLimit-* on
      // every route uniformly — that's a separate, existing concern. What
      // FR-016/contracts/auth-abuse-endpoints.md actually requires is that
      // THIS bound doesn't leak budget state, which the header-SET-EQUALITY
      // check below already proves: whatever headers are present, they are
      // byte-identical in NAME between the known and unknown bursts at every
      // position, so nothing here differs by address.
      expect(Object.keys(knownResults[i].headers).sort()).toEqual(
        Object.keys(unknownResults[i].headers).sort(),
      );
    }
    // Two per-burst alignments can each wait up to the 30s margin, plus 16
    // sequential requests — comfortably past jest-e2e.json's 30s default.
    // Mirrors the file-level beforeEach's own 70s allowance for the same
    // reason (real calendar-window waiting, not slow assertions).
  }, 150_000);

  // ── T062/SC-007 — normalisation ──────────────────────────────────────────
  // Case variants only — a leading/trailing-whitespace email fails
  // ForgotPasswordDto's pre-existing `@IsEmail()` validation (validator.js's
  // isEmail rejects surrounding whitespace; confirmed directly against this
  // repo's validator version) and is refused with 400 before it ever reaches
  // this service's normalization or the limiter. That DTO behaviour predates
  // 009 and changing it is out of this feature's frozen scope (no Phase 5-7
  // task touches ForgotPasswordDto's validators). Since the limiter's
  // subject and the account lookup both call the exact same
  // `normalizeEmail()` (trim + lowercase) on whatever the DTO lets through,
  // FR-012's guarantee holds for every value that can actually arrive over
  // HTTP; case variation is the reachable, representative case this test
  // proves end-to-end.
  it('T062 case variants of one address spread across a burst consume ONE budget', async () => {
    const { email } = await createRecoverableUser(e2e, 'normalize');
    const variants = [email, email.toUpperCase()];
    const statuses: number[] = [];
    for (let i = 0; i < BUDGET + 2; i++) {
      const variant = variants[i % variants.length];
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email: variant });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(BUDGET);
    expect(statuses.filter((s) => s === 429)).toHaveLength(statuses.length - BUDGET);
  });

  // ── T063/SC-006 — normal use is never refused ────────────────────────────
  it('T063 one request, a pause past the window, one more request — both succeed', async () => {
    const { email } = await createRecoverableUser(e2e, 'normal-use');
    const first = await request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email });
    expect(first.status).toBe(200);

    await sleep((WINDOW_SECONDS + 1) * 1000);

    const second = await request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email });
    expect(second.status).toBe(200);
  }, 75_000);

  // ── T064/FR-017 — concurrency ─────────────────────────────────────────────
  it('T064 parallel requests one short of exhaustion admit at most the remaining budget — no read-then-write race', async () => {
    const { email } = await createRecoverableUser(e2e, 'concurrency');

    // Consume BUDGET-1 sequentially first, leaving exactly 1 remaining.
    for (let i = 0; i < BUDGET - 1; i++) {
      const res = await request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email });
      expect(res.status).toBe(200);
    }

    // Fire several concurrent requests at the last remaining slot.
    const concurrentCount = 5;
    const results = await Promise.all(
      Array.from({ length: concurrentCount }, () =>
        request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email }),
      ),
    );
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBeLessThanOrEqual(1); // at most the single remaining slot, never more
  });

  // ── T065/SC-005a — degraded mode ─────────────────────────────────────────
  describe('degraded mode (Redis unavailable)', () => {
    // Within-budget degraded requests correctly proceed to a REAL email
    // dispatch attempt (FR-062 requires exactly this — degraded mode is not
    // "always suppress", only over-threshold requests suppress). Dispatch is
    // forced to EMAIL_SYNC (see the env-setup file) specifically so it never
    // touches the also-Redis-backed BullMQ producer connection while Redis
    // is stopped — that connection's pre-existing, out-of-scope
    // enableOfflineQueue/no-commandTimeout retry policy (redis.config.ts)
    // would otherwise eventually exhaust its default maxRetriesPerRequest
    // against a genuinely stopped Redis and crash the test process (observed
    // directly while developing this suite). This listener is a
    // belt-and-braces second layer in case any OTHER Redis-backed path this
    // feature does not own hits the same class of failure — it swallows
    // only that specific, pre-existing error signature and rethrows
    // anything else, so it can never mask a real assertion failure.
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
      await sleep(1_500); // let ioredis reconnect before the next describe block's tests run
    });

    it('T065 a burst past the local threshold returns the ordinary generic success every time, bounded side effects, indistinguishable from healthy', async () => {
      const { email } = await createRecoverableUser(e2e, 'degraded');
      const statuses: number[] = [];
      const bodies: unknown[] = [];

      // DEGRADED_BUDGET + 2 (not +5): each request against a STOPPED Redis
      // pays the full 2s commandTimeout before falling back locally, so
      // keeping this burst small keeps the test's wall-clock time sane.
      for (let i = 0; i < DEGRADED_BUDGET + 2; i++) {
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/auth/forgot-password`)
          .send({ email });
        statuses.push(res.status);
        bodies.push(res.body);
      }

      // EVERY response is 200 with the ordinary generic message — no 429,
      // nothing indicating degradation.
      expect(statuses.every((s) => s === 200)).toBe(true);
      for (const body of bodies) {
        expect(body).toEqual({ message: GENERIC_MESSAGE });
      }

      const rowCount = await passwordResetCountFor(e2e, email);
      const sentCount = await emailLogCountFor(e2e, email);
      expect(rowCount).toBeLessThanOrEqual(DEGRADED_BUDGET);
      expect(sentCount).toBeLessThanOrEqual(DEGRADED_BUDGET);
    }, 60_000);

    it('T065 (anti-enumeration variant) an unregistered address behaves identically while degraded — same status/body as a registered one', async () => {
      const unregistered = unknownEmail('degraded-unknown');
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email: unregistered });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: GENERIC_MESSAGE });
    });
  });

  // ── T066 — post-rejection side-effect assertion (healthy mode) ──────────
  it('T066 after a healthy-mode 429, no account lookup, token, row or queued job was produced for that specific request', async () => {
    const { email } = await createRecoverableUser(e2e, 'post-rejection');
    for (let i = 0; i < BUDGET; i++) {
      await request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email });
    }
    const rowsBeforeRejection = await passwordResetCountFor(e2e, email);
    const sentBeforeRejection = await emailLogCountFor(e2e, email);

    const rejected = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/forgot-password`)
      .send({ email });
    expect(rejected.status).toBe(429);

    const rowsAfterRejection = await passwordResetCountFor(e2e, email);
    const sentAfterRejection = await emailLogCountFor(e2e, email);
    expect(rowsAfterRejection).toBe(rowsBeforeRejection); // no new row
    expect(sentAfterRejection).toBe(sentBeforeRejection); // no new dispatch
  });

  // ── T067/FR-062b — recovery ───────────────────────────────────────────────
  it('T067 after Redis returns, the endpoint resumes Redis-backed enforcement with no restart', async () => {
    const { email } = await createRecoverableUser(e2e, 'recovery');

    dockerStop();
    try {
      for (let i = 0; i < DEGRADED_BUDGET; i++) {
        await request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email });
      }
      // Still degraded: further requests are silent-success, not 429.
      const stillDegraded = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email });
      expect(stillDegraded.status).toBe(200);
    } finally {
      safely(dockerStart);
    }

    await sleep(1_500); // let ioredis reconnect, no API restart

    // Redis's own counter for this identity was never touched while it was
    // down, so healthy-mode enforcement resumes with a fresh Redis-backed
    // budget — up to BUDGET more requests succeed before a real 429.
    const postRecoveryStatuses: number[] = [];
    for (let i = 0; i < BUDGET + 2; i++) {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email });
      postRecoveryStatuses.push(res.status);
    }
    expect(postRecoveryStatuses).toContain(429); // real Redis-backed refusal resumes
    expect(postRecoveryStatuses.filter((s) => s === 200)).toHaveLength(BUDGET);
  }, 20_000);

  // ── No-sensitive-logging (SC-016) ────────────────────────────────────────
  it('no email or account-recovery payload appears in any warning log produced by a forgot-password burst', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();
    const { email } = await createRecoverableUser(e2e, 'log-safety');

    for (let i = 0; i < BUDGET + 3; i++) {
      await request(e2e.app.getHttpServer()).post(`${API}/auth/forgot-password`).send({ email });
    }

    const allLoggedText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLoggedText).not.toContain(email);
    warnSpy.mockRestore();
  });

  // ═══════════════════════════ ZT-010 — tenant recovery ═══════════════════
  // Phase 6, User Story 1. Independent test: a tenant-scoped account with no
  // tenantSlug produces a reset row and a dispatched message, while the
  // response stays byte-identical to the unknown-address case.
  describe('ZT-010 — recovery lookup correctness', () => {
    // requestId/timestamp are legitimately unique per HTTP call — see T061's
    // own comment. Strips both before a body-equality comparison.
    const stableBody = (body: unknown) => {
      const { requestId: _r, timestamp: _t, ...rest } = (body ?? {}) as Record<string, unknown>;
      return rest;
    };

    it('T073 a tenant-scoped clinic owner supplying only their email receives a reset — currently nothing happens', async () => {
      const { email } = await createRecoverableUser(e2e, 'zt010-owner');

      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email }) // no tenantSlug
        .expect(200);

      expect(res.body).toEqual({ message: GENERIC_MESSAGE });
      const rowCount = await passwordResetCountFor(e2e, email);
      expect(rowCount).toBe(1);
      const sentCount = await emailLogCountFor(e2e, email);
      expect(sentCount).toBe(1);
    });

    it('T074 that success response is byte-identical to the unknown-address response', async () => {
      const { email } = await createRecoverableUser(e2e, 'zt010-parity-known');
      const unregistered = unknownEmail('zt010-parity-unknown');

      const knownRes = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email })
        .expect(200);
      const unknownRes = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email: unregistered })
        .expect(200);

      expect(stableBody(knownRes.body)).toEqual(stableBody(unknownRes.body));
      expect(knownRes.status).toBe(unknownRes.status);
    });

    it('T075 platform super-admin recovery still works exactly as today', async () => {
      const { email } = await createSuperAdminUser(e2e, 'zt010-superadmin');

      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email })
        .expect(200);

      expect(res.body).toEqual({ message: GENERIC_MESSAGE });
      const rowCount = await passwordResetCountFor(e2e, email);
      expect(rowCount).toBe(1);
    });

    it('T076 a valid tenantSlug keeps the lookup scoped to that tenant; an unresolvable tenantSlug issues no reset and does not widen', async () => {
      const { email, tenantSlug } = await createRecoverableUser(e2e, 'zt010-scoped');

      const scopedRes = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email, tenantSlug })
        .expect(200);
      expect(scopedRes.body).toEqual({ message: GENERIC_MESSAGE });
      expect(await passwordResetCountFor(e2e, email)).toBe(1);

      // Same account, but a slug that doesn't resolve to any tenant: must
      // NOT widen into an unscoped search and must NOT issue a second reset
      // for this call.
      const beforeUnresolvable = await passwordResetCountFor(e2e, email);
      const unresolvableRes = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email, tenantSlug: `nonexistent-${Date.now()}` })
        .expect(200);
      expect(unresolvableRes.body).toEqual({ message: GENERIC_MESSAGE });
      expect(await passwordResetCountFor(e2e, email)).toBe(beforeUnresolvable); // unchanged — no widening
    });

    it('T077 no tenant membership or existence information leaks — matched, unmatched and unresolved-qualifier branches all return the same body', async () => {
      const { email: matchedEmail } = await createRecoverableUser(e2e, 'zt010-leak-matched');
      const unmatchedEmail = unknownEmail('zt010-leak-unmatched');

      const matched = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email: matchedEmail })
        .expect(200);
      const unmatched = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email: unmatchedEmail })
        .expect(200);
      const unresolvedQualifier = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email: unknownEmail('zt010-leak-unresolved'), tenantSlug: `nonexistent-${Date.now()}` })
        .expect(200);

      const bodies = [matched, unmatched, unresolvedQualifier].map((r) => stableBody(r.body));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
    });

    it('T078 invariant-violation branch: two live rows for one email (index temporarily absent) issues no reset to any record, returns the uniform response, and emits a safe observability signal', async () => {
      const duplicateEmail = `zt010-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
      const tenants = e2e.dataSource.getRepository(Tenant);
      const users = e2e.dataSource.getRepository(User);

      const tenantA = await tenants.save(
        tenants.create({
          name: 'ZT-010 Dup Tenant A',
          slug: `e2e-zt010-dup-a-${Date.now()}`,
          contact_email: `e2e-zt010-dup-a-${Date.now()}@example.test`,
          approval_status: TenantApprovalStatus.APPROVED,
          is_active: true,
        }),
      );
      const tenantB = await tenants.save(
        tenants.create({
          name: 'ZT-010 Dup Tenant B',
          slug: `e2e-zt010-dup-b-${Date.now()}`,
          contact_email: `e2e-zt010-dup-b-${Date.now()}@example.test`,
          approval_status: TenantApprovalStatus.APPROVED,
          is_active: true,
        }),
      );

      // Simulate the uq_user_email_global invariant being lost: drop the
      // index (disposable database only — see this file's header), insert a
      // SECOND live user sharing the email across two different tenants
      // (structurally impossible with the index in place), then always
      // restore it, even if an assertion below fails.
      await e2e.dataSource.query(`DROP INDEX IF EXISTS uq_user_email_global`);
      let userA: User | undefined;
      let userB: User | undefined;
      try {
        userA = await users.save(
          users.create({
            tenant: { id: tenantA.id } as Tenant,
            email: duplicateEmail,
            full_name: 'Dup User A',
            is_active: true,
            password_hash: 'irrelevant',
          }),
        );
        userB = await users.save(
          users.create({
            tenant: { id: tenantB.id } as Tenant,
            email: duplicateEmail,
            full_name: 'Dup User B',
            is_active: true,
            password_hash: 'irrelevant',
          }),
        );

        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/auth/forgot-password`)
          .send({ email: duplicateEmail })
          .expect(200);
        expect(res.body).toEqual({ message: GENERIC_MESSAGE });

        const rowCount = await passwordResetCountFor(e2e, duplicateEmail);
        expect(rowCount).toBe(0); // no reset issued to EITHER record
      } finally {
        if (userA) await users.delete({ id: userA.id });
        if (userB) await users.delete({ id: userB.id });
        await cleanupTenant(e2e, tenantA.id);
        await cleanupTenant(e2e, tenantB.id);
        // Restore exactly as the migration creates it (GlobalUserEmailUniqueness).
        await e2e.dataSource.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_email_global ON users(email) WHERE deleted_at IS NULL AND email IS NOT NULL`,
        );
      }
    }, 30_000);
  });
});
