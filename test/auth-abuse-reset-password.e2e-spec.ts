/**
 * 009-auth-abuse-resistance — ZT-006 reset-password layered abuse bound,
 * HTTP e2e. Boots the REAL AppModule against real (disposable) Postgres +
 * Redis via `createE2eApp`, same infrastructure as the forgot-password and
 * login-protection suites.
 *
 * MUST be the first import: see login-protection-env.setup.ts's docstring
 * for why the fast test values must be set before AppModule is ever
 * required in this file's module registry.
 *
 * **Shared-counter note.** Unlike forgot-password's identity-keyed bound
 * (each test naturally gets its own key via a fresh email), the invalid-
 * token failure ceiling (RESET_INVALID) is deliberately ENDPOINT-WIDE — one
 * counter, one key, for the whole file (FR-064: a fresh random token per
 * attempt must not evade it). Any test that depends on that counter's exact
 * value therefore calls `alignToFreshWindowGuaranteed` first, so it starts
 * from a real, verified zero rather than inheriting whatever an earlier
 * test in this file already consumed.
 */
import './utils/auth-abuse-reset-password-env.setup';

import { randomBytes, createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import request from 'supertest';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { dockerStop, dockerStart, safely, sleep, waitForRedisReady } from './utils/docker-redis-control';
import { alignToFreshWindowGuaranteed } from './utils/window-alignment';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { User } from '../src/entities/Auth&RBAC/User';
import { PasswordReset } from '../src/entities/Auth&RBAC/PasswordReset';
import { TenantApprovalStatus } from '../src/entities/enums';

const API = '/api/v1';
const ACCOUNT_BUDGET = Number(process.env.AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT); // 5
const INVALID_CEILING = Number(process.env.AUTH_RESET_PASSWORD_INVALID_CEILING); // 20
const WINDOW_SECONDS = Number(process.env.AUTH_RESET_PASSWORD_WINDOW_SECONDS); // 60
const DEGRADED_ACCOUNT_BUDGET = Math.max(
  1,
  Math.ceil(ACCOUNT_BUDGET * Number(process.env.AUTH_ABUSE_DEGRADED_FACTOR)),
);
const DEGRADED_INVALID_CEILING = Math.max(
  1,
  Math.ceil(INVALID_CEILING * Number(process.env.AUTH_ABUSE_DEGRADED_FACTOR)),
);

/** Matches AuthService.hashToken exactly (SHA-256 hex) — see auth.service.ts. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function freshRandomToken(): string {
  return randomBytes(32).toString('hex');
}

async function createUser(e2e: E2eApp, label: string): Promise<{ tenantId: string; userId: string }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenants = e2e.dataSource.getRepository(Tenant);
  const users = e2e.dataSource.getRepository(User);

  const tenant = await tenants.save(
    tenants.create({
      name: `E2E Reset-Password ${suffix}`,
      slug: `e2e-reset-${suffix}`,
      contact_email: `e2e-reset-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );
  const user = await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email: `reset-${suffix}@example.test`,
      full_name: `E2E Reset-Password User ${suffix}`,
      is_active: true,
      password_hash: 'irrelevant-not-used-by-reset-password',
    }),
  );
  return { tenantId: tenant.id, userId: user.id };
}

/** Issues a real, valid, single-use reset token for `userId` — mirrors AuthService.forgotPassword's own token issuance exactly. */
async function issueValidToken(
  e2e: E2eApp,
  userId: string,
  ttlMinutes = 30,
): Promise<string> {
  const rawToken = freshRandomToken();
  const passwordResets = e2e.dataSource.getRepository(PasswordReset);
  await passwordResets.save(
    passwordResets.create({
      user: { id: userId } as User,
      token_hash: hashToken(rawToken),
      expires_at: new Date(Date.now() + ttlMinutes * 60_000),
    }),
  );
  return rawToken;
}

async function passwordResetUsedAt(e2e: E2eApp, rawToken: string): Promise<Date | null> {
  const rows: { used_at: Date | null }[] = await e2e.dataSource.query(
    `SELECT used_at FROM password_resets WHERE token_hash = $1`,
    [hashToken(rawToken)],
  );
  return rows[0]?.used_at ?? null;
}

function resetRequest(e2e: E2eApp, token: string, newPassword = 'NewStr0ng!Pass') {
  return request(e2e.app.getHttpServer())
    .post(`${API}/auth/reset-password`)
    .send({ token, newPassword });
}

describe('Reset-password abuse bound — HTTP e2e (009, ZT-006)', () => {
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
      `SELECT id FROM tenants WHERE slug LIKE 'e2e-reset-%'`,
    );
    for (const row of rows) {
      await cleanupTenant(e2e, row.id);
    }
    await e2e.app.close();
  }, 30_000);

  it('sanity: the configured bounds are the test values, not the production defaults', () => {
    expect(ACCOUNT_BUDGET).toBe(5);
    expect(INVALID_CEILING).toBe(20);
    expect(WINDOW_SECONDS).toBe(60);
  });

  // ── T089/T091/FR-064 — golden path, replay, and the failure-only ceiling ─
  // Combined into one test (its own guaranteed-fresh window) because every
  // assertion here reads the SAME endpoint-wide RESET_INVALID counter and
  // needs a known, exact starting value.
  it('T089/T091 valid token succeeds, replay fails, invalid attempts are bounded, and a success never consumes that bound', async () => {
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS);
    const { userId } = await createUser(e2e, 'golden');

    // Golden path.
    const validToken = await issueValidToken(e2e, userId);
    const first = await resetRequest(e2e, validToken);
    expect(first.status).toBe(200);
    expect(await passwordResetUsedAt(e2e, validToken)).not.toBeNull();

    // T089 — replay of a used token: existing generic error, unchanged.
    const replay = await resetRequest(e2e, validToken);
    expect(replay.status).toBe(400);
    expect(replay.body.code ?? replay.body.error?.code).toBe('INVALID_RESET_TOKEN');

    // T089 — expired token: same generic error.
    const expiredToken = await issueValidToken(e2e, userId, -1);
    const expired = await resetRequest(e2e, expiredToken);
    expect(expired.status).toBe(400);

    // Counter so far: replay + expired = 2 invalid attempts consumed.
    // Drive it to exactly one below the ceiling with more genuine failures.
    for (let i = 0; i < INVALID_CEILING - 2 - 1; i++) {
      const res = await resetRequest(e2e, freshRandomToken());
      expect(res.status).toBe(400);
    }

    // T091/FR-064 — a SUCCESSFUL reset in between must not itself count as
    // a failure: if it did, the next check below would be refused early.
    const midToken = await issueValidToken(e2e, userId);
    const midSuccess = await resetRequest(e2e, midToken);
    expect(midSuccess.status).toBe(200);

    // Exactly one failure slot must still remain.
    const lastSlot = await resetRequest(e2e, freshRandomToken());
    expect(lastSlot.status).toBe(400); // the ceiling-th failure — still "normal"

    const overCeiling = await resetRequest(e2e, freshRandomToken());
    expect(overCeiling.status).toBe(429); // FR-064 — now refused, not silently accepted
  }, 90_000);

  // ── T090/SC-005b — random-token flood defeats a per-token key ───────────
  it('T090 a 200-request flood, each with a fresh random token, is refused at the failure ceiling despite every token being distinct', async () => {
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS);
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const res = await resetRequest(e2e, freshRandomToken());
      statuses.push(res.status);
    }
    const invalidCount = statuses.filter((s) => s === 400).length;
    const refusedCount = statuses.filter((s) => s === 429).length;
    expect(invalidCount).toBe(INVALID_CEILING); // exactly the ceiling worth of "normal" invalid responses
    expect(refusedCount).toBe(200 - INVALID_CEILING); // everything past it is refused, not silently accepted
  }, 100_000);

  // ── T092/T093(account)/FR-063/FR-017 — account-target bound ─────────────
  // Both use ONLY valid tokens, so neither increments the invalid-ceiling
  // counter — combined under one guaranteed-fresh window (that counter only
  // needs to have ROOM, not a specific value, for either sub-scenario).
  it('T092/T093 repeated valid-token resets for one account are bounded, including under concurrency', async () => {
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS);
    const { userId } = await createUser(e2e, 'account-bound');
    const statuses: number[] = [];

    for (let i = 0; i < ACCOUNT_BUDGET + 3; i++) {
      const token = await issueValidToken(e2e, userId); // a fresh valid token each time — proves the bound is ACCOUNT-keyed, not token-keyed
      const res = await resetRequest(e2e, token, `NewStr0ng!Pass${i}`);
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 200)).toHaveLength(ACCOUNT_BUDGET);
    expect(statuses.filter((s) => s === 429)).toHaveLength(statuses.length - ACCOUNT_BUDGET);

    // T093 (account concurrency) — a SEPARATE account, same window: drain to
    // one remaining slot, then race for it.
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS);
    const { userId: concurrencyUserId } = await createUser(e2e, 'concurrency-account');
    for (let i = 0; i < ACCOUNT_BUDGET - 1; i++) {
      const token = await issueValidToken(e2e, concurrencyUserId);
      const res = await resetRequest(e2e, token, `Seq${i}Pass123!`);
      expect(res.status).toBe(200);
    }
    const concurrentCount = 5;
    const tokens = await Promise.all(
      Array.from({ length: concurrentCount }, () => issueValidToken(e2e, concurrencyUserId)),
    );
    const results = await Promise.all(
      tokens.map((token) => resetRequest(e2e, token, 'ConcurrentPass123!')),
    );
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBeLessThanOrEqual(1); // at most the single remaining account slot
  }, 150_000);

  // ── T093/FR-017 — concurrency, rotating random tokens ────────────────────
  it('T093 concurrent attempts with rotating random tokens cannot bypass the failure ceiling', async () => {
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS);
    // Drive the ceiling to one remaining slot sequentially first.
    for (let i = 0; i < INVALID_CEILING - 1; i++) {
      await resetRequest(e2e, freshRandomToken());
    }

    const concurrentCount = 6;
    const results = await Promise.all(
      Array.from({ length: concurrentCount }, () => resetRequest(e2e, freshRandomToken())),
    );
    const admittedCount = results.filter((r) => r.status === 400).length; // "admitted" = reached the real invalid-token check
    expect(admittedCount).toBeLessThanOrEqual(1); // at most the single remaining slot, never more
  }, 100_000);

  // ── T095/FR-065a/SC-016 — no raw token in any log ────────────────────────
  it('no raw reset token appears in any warning log line produced by any of the above scenarios', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();
    const { userId } = await createUser(e2e, 'log-safety');
    const validToken = await issueValidToken(e2e, userId);
    const invalidToken = freshRandomToken();

    await resetRequest(e2e, validToken);
    await resetRequest(e2e, invalidToken);

    const allLoggedText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLoggedText).not.toContain(validToken);
    expect(allLoggedText).not.toContain(invalidToken);
    warnSpy.mockRestore();
  });

  // ── T094/FR-065b — degraded mode ─────────────────────────────────────────
  // The local fallback counter for each scope is constructed lazily on
  // first degraded use and lives independently PER SCOPE (see
  // FixedWindowLimiterService.fallbackFor) — so these two sub-tests, using
  // the RESET_INVALID and RESET_ACCOUNT scopes respectively, are naturally
  // isolated from each other and from every earlier HEALTHY-mode test's
  // Redis-backed counter state above, with no alignment needed.
  describe('degraded mode (Redis unavailable)', () => {
    beforeAll(() => {
      dockerStop();
    });
    afterAll(async () => {
      safely(dockerStart);
      await sleep(1_500);
    });

    // Order matters here (Jest runs `it`s within a describe in declaration
    // order): resetPassword() calls the RESET_INVALID peek() on EVERY
    // request regardless of token validity, so this account-bound test
    // (which only cares about RESET_ACCOUNT) MUST run before anything
    // drives RESET_INVALID's local fallback up — that fallback is a single
    // instance shared for the rest of this describe block's Redis-down
    // window (constructed lazily on first degraded use, not reset between
    // `it`s), unlike each Redis-backed HEALTHY-mode test above which gets a
    // fresh window via alignToFreshWindowGuaranteed. This is genuinely the
    // FIRST degraded-mode use of RESET_INVALID in the whole file, so it
    // starts at zero here without needing that helper.
    it('T094 the account bound still bounds repeated valid-token resets while Redis is down', async () => {
      const { userId } = await createUser(e2e, 'degraded-account');
      const statuses: number[] = [];
      for (let i = 0; i < DEGRADED_ACCOUNT_BUDGET + 2; i++) {
        const token = await issueValidToken(e2e, userId);
        const res = await resetRequest(e2e, token, `DegradedPass${i}123!`);
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 200)).toHaveLength(DEGRADED_ACCOUNT_BUDGET);
      expect(statuses.filter((s) => s === 429)).toHaveLength(statuses.length - DEGRADED_ACCOUNT_BUDGET);
    }, 45_000);

    it('T094 the failure ceiling still bounds an invalid-token flood while Redis is down', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < DEGRADED_INVALID_CEILING + 3; i++) {
        const res = await resetRequest(e2e, freshRandomToken());
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 400)).toHaveLength(DEGRADED_INVALID_CEILING);
      expect(statuses.filter((s) => s === 429)).toHaveLength(statuses.length - DEGRADED_INVALID_CEILING);
    }, 45_000);
  });

  it('T094 after Redis recovers, enforcement resumes on the real Redis-backed ceiling with no restart', async () => {
    dockerStop();
    try {
      for (let i = 0; i < DEGRADED_INVALID_CEILING; i++) {
        await resetRequest(e2e, freshRandomToken());
      }
      const stillDegraded = await resetRequest(e2e, freshRandomToken());
      expect(stillDegraded.status).toBe(429);
    } finally {
      safely(dockerStart);
    }
    await sleep(1_500);
    await alignToFreshWindowGuaranteed(WINDOW_SECONDS); // guaranteed-fresh Redis-backed window — no leftover local-fallback state to confuse the count

    const postRecoveryStatuses: number[] = [];
    for (let i = 0; i < INVALID_CEILING + 2; i++) {
      const res = await resetRequest(e2e, freshRandomToken());
      postRecoveryStatuses.push(res.status);
    }
    expect(postRecoveryStatuses.filter((s) => s === 400)).toHaveLength(INVALID_CEILING);
    expect(postRecoveryStatuses.filter((s) => s === 429)).toHaveLength(2);
  }, 150_000);
});
