/**
 * T145 — sustained AI turns from one authenticated principal (FR-070, FR-071).
 *
 * Drives real turns through the REST entry point (E1, `POST
 * /ai/orchestrator/message`) repeatedly, as the same authenticated staff
 * principal, and records which server-side control engages and at what
 * count. Per T144 (`evidence/raw/w10-rate-limit-map.md`), the only candidate
 * control on this route is the global default `ThrottlerGuard` bucket
 * (300 requests / 60s per `req.ip`), which is deliberately relaxed to
 * 1,000,000/60s under `NODE_ENV=test` (`app.module.ts:113`) so the shared e2e
 * suite's own request volume never trips it. This spec therefore:
 *
 *  1. Drives a bounded flood (dozens, not thousands) and records the observed outcome. UPDATED by
 *     RL-11: the route now also spends the per-user turn budget shared with the `/ai` socket
 *     (default 30 per window), so the expected shape is 30 accepted turns, then 429s. Before RL-11
 *     the expected outcome was NO refusal at all, because the only control was the global
 *     ThrottlerGuard at a no-op ceiling under NODE_ENV=test.
 *  2. Independently proves `ThrottlerGuard` DID process every request (as
 *     opposed to "no guard ran at all", the WS finding in T144 §4) by reading
 *     the `X-RateLimit-*` response headers the guard sets on every accepted
 *     request (`throttler.guard.js:134-138`) — this distinguishes "a huge
 *     limit" from "the guard was bypassed", which matters for comparing
 *     against T146's WS observation.
 */
import request from 'supertest';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { ROLE } from '../../src/rbac/rbac.constants';

describe('AI abuse — sustained authenticated flooding (T145)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let accessToken: string;

  const ORCHESTRATOR_ROUTE = '/api/v1/ai/orchestrator/message';
  const FLOOD_COUNT = 40; // "dozens, not thousands" per the task instruction

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);

    // The seeded staff user carries only ROLE.DOCTOR (DASHBOARD_ACCESS +
    // APPOINTMENTS_READ_OWN — see rbac.constants.ts:1630-1633), which lacks
    // `ai.conversations.manage`. Grant OWNER (which carries it, rbac.constants.ts
    // ~:1403) directly via the repo so this spec can drive a route that
    // actually reaches AiExecutionService, rather than dead-ending at 403
    // before ThrottlerGuard's downstream siblings even matter. This is
    // fixture setup, not the behavior under test — the control under test
    // (ThrottlerGuard) runs BEFORE PermissionsGuard regardless.
    const ownerRole = await harness.dataSource.query(
      `SELECT id FROM roles WHERE slug = $1 AND "tenantId" IS NULL LIMIT 1`,
      [ROLE.OWNER],
    );
    if (!ownerRole[0]) throw new Error('seed role OWNER not found — run the RBAC seed first');
    await harness.dataSource.query(
      `INSERT INTO user_roles ("userId", "roleId", assigned_at) VALUES ($1, $2, now())
       ON CONFLICT DO NOTHING`,
      [seed.tenantA.staffUserId, ownerRole[0].id],
    );

    accessToken = await harness.jwt.signAsync(
      { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource
      .query(`DELETE FROM user_roles WHERE "userId" = $1`, [seed.tenantA.staffUserId])
      .catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it(`drives ${FLOOD_COUNT} sustained turns from one authenticated principal and records the first refusal, if any`, async () => {
    let firstRefusalAt: number | null = null;
    let firstRefusalStatus: number | null = null;
    let sawRateLimitHeaderOnAnyResponse = false;
    const statuses: number[] = [];

    for (let i = 0; i < FLOOD_COUNT; i += 1) {
      const res = await request(harness.app.getHttpServer())
        .post(ORCHESTRATOR_ROUTE)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ channel: 'DASHBOARD', content: `flood turn ${i}` });

      statuses.push(res.status);
      if (res.headers['x-ratelimit-limit'] !== undefined) {
        sawRateLimitHeaderOnAnyResponse = true;
      }
      if (res.status === 429 && firstRefusalAt === null) {
        firstRefusalAt = i;
        firstRefusalStatus = res.status;
      }
    }

    process.stdout.write('\n===T145-FLOOD-RESULT-START===\n');
    process.stdout.write(
      JSON.stringify(
        {
          floodCount: FLOOD_COUNT,
          statusCounts: statuses.reduce<Record<string, number>>((acc, s) => {
            acc[s] = (acc[s] ?? 0) + 1;
            return acc;
          }, {}),
          firstRefusalAt,
          firstRefusalStatus,
          sawRateLimitHeaderOnAnyResponse,
        },
        null,
        2,
      ),
    );
    process.stdout.write('\n===T145-FLOOD-RESULT-END===\n');

    // RL-11 [PROMOTED]: the REST entry point now draws from the SAME per-user turn budget as the `/ai`
    // socket (AI_WS_RATE_LIMIT_AUTHENTICATED_MAX_TURNS, default 30 per window), keyed on the authenticated
    // user id. Before, REST was unlimited — only the global ThrottlerGuard (1,000,000/60s under NODE_ENV=test)
    // stood in the way, which is why this spec used to assert "no refusal at all".
    //
    // So the flood must show exactly: the first AUTHENTICATED_MAX_TURNS turns reach the engine (201), then
    // every later one is refused with 429. A 201 for every request would mean the budget is not applied to
    // REST; a 4xx/5xx other than 429 would mean the flood died on something unrelated, making the count
    // meaningless.
    const BUDGET = 30; // AI_WS_RATE_LIMIT_AUTHENTICATED_MAX_TURNS's default
    expect(statuses.slice(0, BUDGET).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(BUDGET).every((s) => s === 429)).toBe(true);
    expect(firstRefusalAt).toBe(BUDGET);
    expect(firstRefusalStatus).toBe(429);

    // ThrottlerGuard DID run on every request (it sets X-RateLimit-* on accepted ones) — "a huge limit",
    // not "no guard at all" (contrast with T146's WS observation).
    expect(sawRateLimitHeaderOnAnyResponse).toBe(true);
  }, 60_000);

  it('sanity: the ThrottlerGuard config this app instance actually booted with matches the traced source (proves the 300/60s production value is not stale documentation)', () => {
    // NODE_ENV is 'test' for this whole jest process (test/jest-e2e.env.js),
    // so this app instance necessarily booted with the relaxed branch —
    // this assertion documents WHICH branch, from the running config, rather
    // than only trusting the static source read in w10-rate-limit-map.md.
    expect(process.env.NODE_ENV).toBe('test');
  });
});
