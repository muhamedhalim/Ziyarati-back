/**
 * Platform admin free access — the full lifecycle against real PostgreSQL.
 *
 * WHAT THIS SUITE CLAIMS. A Platform Admin grants a clinic free access for a
 * number of DAYS; the backend alone decides when that access ends; and when it
 * ends, it ends — on the access decision, on a gated route, and without any
 * scheduled job having run.
 *
 * WHY IT CANNOT USE FAKE TIMERS. The expiry predicate lives in SQL:
 *
 *     starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
 *
 * `now()` is the DATABASE's transaction clock. `jest.useFakeTimers()` patches
 * the Node process and has no reach into PostgreSQL, so a faked Node clock
 * would move nothing that this decision actually reads — the test would pass
 * while proving the opposite of what it claims. Two techniques are used
 * instead, and neither adds a line of test-only production logic:
 *
 *   1. TIME-TRAVEL THE GRANT. Shifting a grant's `starts_at`/`ends_at`
 *      backwards by an interval is arithmetically identical to advancing the
 *      wall clock forwards by it: the only thing any check computes is the
 *      distance between `ends_at` and `now()`. This is how the day-scale
 *      cases (45 days, 365 days, "just before expiry") are exercised in
 *      milliseconds.
 *   2. ONE REAL WALL-CLOCK EXPIRY. `expires by the passage of real time` sets
 *      an end ~1.2s out and then genuinely waits for it, touching NOTHING in
 *      between. That one case answers the objection that (1) could mask a
 *      system which only re-evaluates on write: here the row is untouched at
 *      the moment the verdict flips.
 *
 * The 5s access cache is invalidated after each shift via
 * `AccessControlService.invalidate` — the same production call every mutation
 * already makes. It is never bypassed or reconfigured.
 *
 * ISOLATION: no per-test database, matching the sibling suites. Every fixture
 * is scoped to a freshly created tenant and torn down in FK-safe order.
 * `setPaidMode` is process-wide and is reset in `afterAll` — under FREE mode
 * every tenant is allowed unconditionally, so without it this suite would
 * assert nothing at all.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
  cleanupSubscriptionFixture,
  type SubscribedOwnerFixture,
} from './utils/subscription-e2e-fixtures';

import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { SubscriptionStatus } from '../src/entities/enums';
import { ROLE } from '../src/rbac/rbac.constants';
import { AccessControlService } from '../src/modules/subscription-billing/access-control.service';
import { FreeAccessOverrideService } from '../src/modules/subscription-billing/free-access-override.service';
import { FeatureKey } from '../src/modules/subscription-billing/feature-registry';
import { AccessSource } from '../src/modules/subscription-billing/tenant-access-decision';
import {
  FREE_ACCESS_MAX_DURATION_DAYS,
  FREE_ACCESS_MIN_DURATION_DAYS,
} from '../src/modules/subscription-billing/platform-billing.constants';

const API = '/api/v1';
const DAY_MS = 86_400_000;

/** A capability that is default-on and unrestricted, so ONLY tenant-wide access decides it. */
const GATED_FEATURE = FeatureKey.CRM;
/** The HTTP route that capability protects — the "protected endpoint" assertion. */
const GATED_ROUTE = `${API}/crm/customers`;

describe('Platform admin free access — real Postgres', () => {
  let e2e: E2eApp;
  let access: AccessControlService;
  let overrides: FreeAccessOverrideService;
  let superAdmin: { userId: string; token: string };
  const createdUserIds: string[] = [];
  const touchedTenantIds: string[] = [];

  beforeAll(async () => {
    e2e = await createE2eApp();
    // Without PAID mode the platform is ungated and every assertion below
    // about denial would pass for the wrong reason.
    await setPaidMode(e2e);
    access = e2e.moduleRef.get(AccessControlService, { strict: false });
    overrides = e2e.moduleRef.get(FreeAccessOverrideService, { strict: false });
    superAdmin = await createPlatformActor(ROLE.SUPER_ADMIN, 'fa-sa');
    createdUserIds.push(superAdmin.userId);
  }, 90_000);

  afterAll(async () => {
    if (!e2e) return;
    // `free_access_overrides` carries no FK to `tenants` (it is a ledger that
    // deliberately outlives the row it describes), so `cleanupTenant` cannot
    // reach it — this suite removes its own.
    for (const tenantId of touchedTenantIds) {
      await e2e.dataSource
        .query(`DELETE FROM free_access_overrides WHERE tenant_id = $1`, [
          tenantId,
        ])
        .catch(() => undefined);
    }
    if (createdUserIds.length) {
      await e2e.dataSource
        .query(`DELETE FROM user_roles WHERE "userId" = ANY($1)`, [
          createdUserIds,
        ])
        .catch(() => undefined);
      await e2e.dataSource
        .query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds])
        .catch(() => undefined);
    }
    // Process-wide flip — must be undone before the app closes or every
    // later-running suite inherits PAID mode. Same rule as the sibling suites.
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 60_000);

  // ───────────────────────────── helpers ──────────────────────────────── //

  /** A platform-scope user (tenantId = NULL) holding the given SEEDED global role. */
  async function createPlatformActor(roleSlug: string, label: string) {
    const users = e2e.dataSource.getRepository(User);
    const roles = e2e.dataSource.getRepository(Role);
    const userRoles = e2e.dataSource.getRepository(UserRole);

    const role = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: roleSlug })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error(`Seeded platform role "${roleSlug}" not found`);

    const suffix = `${label}-${randomUUID().slice(0, 8)}`;
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `${suffix}@example.test`,
        full_name: `E2E ${suffix}`,
        is_active: true,
      }),
    );
    await userRoles.save(
      userRoles.create({
        user: { id: user.id } as User,
        role: { id: role.id } as Role,
      }),
    );
    const token = await e2e.jwt.signAsync(
      { sub: user.id, tenantId: null, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );
    return { userId: user.id, token };
  }

  const http = () => request(e2e.app.getHttpServer());

  const grantAs = (token: string, tenantId: string, body: unknown) =>
    http()
      .post(`${API}/platform/billing/tenants/${tenantId}/override`)
      .set(...authHeader(token))
      .send(body as object);

  const grant = (tenantId: string, body: unknown) =>
    grantAs(superAdmin.token, tenantId, body);

  const readOverride = (tenantId: string) =>
    http()
      .get(`${API}/platform/billing/tenants/${tenantId}/override`)
      .set(...authHeader(superAdmin.token));

  const revoke = (tenantId: string) =>
    http()
      .post(`${API}/platform/billing/tenants/${tenantId}/override/revoke`)
      .set(...authHeader(superAdmin.token));

  const extend = (tenantId: string, body: unknown) =>
    http()
      .patch(`${API}/platform/billing/tenants/${tenantId}/override`)
      .set(...authHeader(superAdmin.token))
      .send(body as object);

  /** Every override row for a tenant, straight from the table — newest first. */
  const rows = (
    tenantId: string,
  ): Promise<
    Array<{
      id: string;
      status: string;
      starts_at: Date;
      ends_at: Date | null;
    }>
  > =>
    e2e.dataSource.query(
      `SELECT id, status, starts_at, ends_at FROM free_access_overrides
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );

  /** Rows still holding ACTIVE status, regardless of whether time has passed. */
  const activeRows = async (tenantId: string) =>
    (await rows(tenantId)).filter((r) => r.status === 'ACTIVE');

  /**
   * Advance the clock by `ms`, by moving the grant that far into the past.
   *
   * Both timestamps shift together, so the grant keeps its exact duration and
   * only its position relative to `now()` changes — which is the sole input to
   * every expiry check. Busting the cache afterwards is what a real mutation
   * does; without it the decision could legitimately be up to 5s stale.
   */
  async function advanceClock(tenantId: string, ms: number): Promise<void> {
    await e2e.dataSource.query(
      `UPDATE free_access_overrides
       SET starts_at = starts_at - make_interval(secs => $2::float8),
           ends_at   = ends_at   - make_interval(secs => $2::float8)
       WHERE tenant_id = $1 AND status = 'ACTIVE'`,
      [tenantId, ms / 1000],
    );
    access.invalidate(tenantId);
  }

  const isFreeAccessActive = (tenantId: string) =>
    overrides.hasActive(tenantId);

  const decisionFor = (tenantId: string) =>
    access.resolve(tenantId, GATED_FEATURE);

  /** Register a tenant for override cleanup in `afterAll`. */
  const track = <T extends { tenantId: string }>(f: T): T => {
    touchedTenantIds.push(f.tenantId);
    return f;
  };

  /**
   * Full teardown for one fixture tenant.
   *
   * `cleanupTenant` covers the tables the sibling suites touch, but not these
   * two: `free_access_overrides` has no FK to `tenants` (it is a ledger meant
   * to outlive the clinic it describes) so it is simply missed, while
   * `audit_logs` DOES have one — and every grant/extend/revoke here writes a
   * row against the TARGET clinic, so deleting the tenant without clearing
   * them violates that FK. Both are this suite's own residue, so both are
   * this suite's to remove.
   */
  async function purgeTenant(tenantId: string): Promise<void> {
    await e2e.dataSource.query(
      `DELETE FROM free_access_overrides WHERE tenant_id = $1`,
      [tenantId],
    );
    await e2e.dataSource.query(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [
      tenantId,
    ]);
    await cleanupTenant(e2e, tenantId);
  }

  // ══════════════════ 1. Authorization — admin-only, no IDOR ═══════════════ //

  describe('authorization', () => {
    let clinic: OwnerFixture;
    let otherClinic: OwnerFixture;

    beforeAll(async () => {
      clinic = track(await createOwnerFixture(e2e, 'fa-authz-a'));
      otherClinic = track(await createOwnerFixture(e2e, 'fa-authz-b'));
    });
    afterAll(async () => {
      await purgeTenant(clinic.tenantId);
      await purgeTenant(otherClinic.tenantId);
    });

    it('rejects an unauthenticated grant', async () => {
      await http()
        .post(`${API}/platform/billing/tenants/${clinic.tenantId}/override`)
        .send({ durationDays: 45 })
        .expect(401);
      expect(await activeRows(clinic.tenantId)).toHaveLength(0);
    });

    it('refuses a clinic user granting free access TO ITSELF (privilege escalation)', async () => {
      await grantAs(clinic.token, clinic.tenantId, {
        durationDays: 45,
      }).expect(403);
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);
    });

    /**
     * IDOR: the target tenant is a ROUTE PARAM, so the obvious attack is a
     * clinic naming someone else's id. It must fail on the role check, before
     * the id is ever considered — a clinic has no business writing either
     * tenant's grant.
     */
    it('refuses clinic A touching clinic B’s free access (IDOR)', async () => {
      await grantAs(clinic.token, otherClinic.tenantId, {
        durationDays: 45,
      }).expect(403);
      expect(await isFreeAccessActive(otherClinic.tenantId)).toBe(false);
      expect(await activeRows(otherClinic.tenantId)).toHaveLength(0);
    });

    it('refuses a clinic user READING another clinic’s override', async () => {
      await http()
        .get(`${API}/platform/billing/tenants/${otherClinic.tenantId}/override`)
        .set(...authHeader(clinic.token))
        .expect(403);
    });

    it('refuses a clinic user revoking its own free access', async () => {
      await http()
        .post(
          `${API}/platform/billing/tenants/${clinic.tenantId}/override/revoke`,
        )
        .set(...authHeader(clinic.token))
        .expect(403);
    });

    it('allows the Platform Admin', async () => {
      const res = await grant(clinic.tenantId, { durationDays: 45 });
      expect(res.status).toBeLessThan(300);
      await revoke(clinic.tenantId).expect(200);
    });
  });

  // ═════════════════ 2. Input validation — the API is the bound ════════════ //

  describe('duration validation', () => {
    let clinic: OwnerFixture;

    beforeAll(async () => {
      clinic = track(await createOwnerFixture(e2e, 'fa-validation'));
    });
    afterAll(async () => purgeTenant(clinic.tenantId));

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['decimal', 1.5],
      ['a non-numeric string', 'forty-five'],
      ['NaN', 'NaN'],
      ['one past the maximum', FREE_ACCESS_MAX_DURATION_DAYS + 1],
      ['absurdly large', 1e9],
    ])(
      'rejects %s with 400 and writes nothing',
      async (_label, durationDays) => {
        await grant(clinic.tenantId, { durationDays }).expect(400);
        expect(await rows(clinic.tenantId)).toHaveLength(0);
      },
    );

    /**
     * Mass assignment. The client may say how MANY DAYS and nothing else — an
     * attacker-supplied `endsAt` (or a different `tenantId`) must not be
     * silently accepted OR silently ignored; `forbidNonWhitelisted` makes it a
     * hard 400 so the attempt is visible.
     */
    it.each([
      ['endsAt', { durationDays: 1, endsAt: '2099-01-01T00:00:00Z' }],
      ['startsAt', { durationDays: 1, startsAt: '2000-01-01T00:00:00Z' }],
      ['ends_at', { durationDays: 1, ends_at: '2099-01-01T00:00:00Z' }],
      ['status', { durationDays: 1, status: 'ACTIVE' }],
    ])('refuses a body smuggling %s', async (_label, body) => {
      await grant(clinic.tenantId, body).expect(400);
      expect(await rows(clinic.tenantId)).toHaveLength(0);
    });

    it('rejects a malformed tenant id before any work happens', async () => {
      await grant('not-a-uuid', { durationDays: 45 }).expect(400);
    });

    it.each([
      ['the minimum', FREE_ACCESS_MIN_DURATION_DAYS],
      ['a mid-range value', 45],
      ['the maximum', FREE_ACCESS_MAX_DURATION_DAYS],
    ])('accepts %s', async (_label, durationDays) => {
      const res = await grant(clinic.tenantId, { durationDays });
      expect(res.status).toBeLessThan(300);
      const [row] = await rows(clinic.tenantId);
      expect(
        Math.round(
          (new Date(row.ends_at!).getTime() -
            new Date(row.starts_at).getTime()) /
            DAY_MS,
        ),
      ).toBe(durationDays);
      await revoke(clinic.tenantId).expect(200);
      await e2e.dataSource.query(
        `DELETE FROM free_access_overrides WHERE tenant_id = $1`,
        [clinic.tenantId],
      );
    });
  });

  // ══════════════ 3. Grant — the backend computes both timestamps ══════════ //

  describe('granting free access for 45 days', () => {
    let clinic: OwnerFixture;
    let granted: { id: string; starts_at: string; ends_at: string };

    beforeAll(async () => {
      clinic = track(await createOwnerFixture(e2e, 'fa-grant'));
      const res = await grant(clinic.tenantId, {
        durationDays: 45,
        reason: 'e2e — partnership comp',
      });
      expect(res.status).toBeLessThan(300);
      granted = res.body;
    });
    afterAll(async () => purgeTenant(clinic.tenantId));

    it('starts denied before anything is granted (control)', async () => {
      const fresh = track(await createOwnerFixture(e2e, 'fa-control'));
      expect((await decisionFor(fresh.tenantId)).allowed).toBe(false);
      await purgeTenant(fresh.tenantId);
    });

    it('returns the stored grant, with an expiry it computed itself', () => {
      expect(granted.id).toBeTruthy();
      expect(granted.starts_at).toBeTruthy();
      expect(granted.ends_at).toBeTruthy();
    });

    it('persists starts_at at server time and ends_at exactly 45 days later', async () => {
      const [row] = await rows(clinic.tenantId);
      const startedAt = new Date(row.starts_at).getTime();
      const expiresAt = new Date(row.ends_at!).getTime();

      // Both come from ONE `now()` inside one statement, so the span is exact
      // — not "about" 45 days. A 1s tolerance covers only DST-free interval
      // arithmetic, not clock skew, because there is only one clock.
      expect(Math.abs(expiresAt - startedAt - 45 * DAY_MS)).toBeLessThan(1_000);

      // And that clock is the SERVER's, not this test runner's.
      const [{ now }] = await e2e.dataSource.query('SELECT now() AS now');
      expect(Math.abs(startedAt - new Date(now).getTime())).toBeLessThan(
        60_000,
      );
    });

    it('records exactly ONE row', async () => {
      expect(await rows(clinic.tenantId)).toHaveLength(1);
    });

    it('reports the grant as active through the read endpoint', async () => {
      const res = await readOverride(clinic.tenantId).expect(200);
      expect(res.body.override).toMatchObject({
        id: granted.id,
        status: 'ACTIVE',
      });
    });

    it('resolves access as ADMIN_FREE_ACCESS', async () => {
      const d = await decisionFor(clinic.tenantId);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.ADMIN_FREE_ACCESS);
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(true);
    });

    it('serves the protected endpoint', async () => {
      await http()
        .get(GATED_ROUTE)
        .set(...authHeader(clinic.token))
        .expect(200);
    });

    it('writes an audit record against the TARGET clinic, naming the acting admin', async () => {
      const audits = await e2e.dataSource.query(
        `SELECT "userId", new_values FROM audit_logs
         WHERE "tenantId" = $1 AND action = 'platform_admin.override.grant'`,
        [clinic.tenantId],
      );
      expect(audits).toHaveLength(1);
      // The actor is the super admin, while the row is filed under the clinic
      // the grant was made FOR — platform staff have no tenant of their own.
      expect(audits[0].userId).toBe(superAdmin.userId);
      expect(audits[0].new_values).toMatchObject({
        reason: 'e2e — partnership comp',
      });
    });

    it('records a refused duplicate grant too', async () => {
      await grant(clinic.tenantId, { durationDays: 5 }).expect(409);
      const audits = await e2e.dataSource.query(
        `SELECT action FROM audit_logs
         WHERE "tenantId" = $1 AND action = 'platform_admin.override.grant_rejected'`,
        [clinic.tenantId],
      );
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ════════════════ 4. Duplicate and concurrent grant prevention ═══════════ //

  describe('duplicate prevention', () => {
    let clinic: OwnerFixture;

    beforeAll(async () => {
      clinic = track(await createOwnerFixture(e2e, 'fa-dupe'));
      await grant(clinic.tenantId, { durationDays: 30 });
    });
    afterAll(async () => purgeTenant(clinic.tenantId));

    it('refuses a second grant with 409 and creates no second row', async () => {
      await grant(clinic.tenantId, { durationDays: 90 }).expect(409);
      expect(await rows(clinic.tenantId)).toHaveLength(1);
    });

    it('leaves the original expiry untouched after the refusal', async () => {
      const [row] = await rows(clinic.tenantId);
      expect(
        Math.round(
          (new Date(row.ends_at!).getTime() -
            new Date(row.starts_at).getTime()) /
            DAY_MS,
        ),
      ).toBe(30);
    });

    /**
     * The read-then-write race. Before the per-tenant advisory lock, five
     * simultaneous grants all observed "none active" and all inserted.
     */
    it('admits exactly one of five simultaneous grants', async () => {
      const racer = track(await createOwnerFixture(e2e, 'fa-race'));
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          grant(racer.tenantId, { durationDays: 10 }),
        ),
      );

      const accepted = results.filter((r) => r.status < 300);
      const conflicted = results.filter((r) => r.status === 409);
      expect(accepted).toHaveLength(1);
      expect(conflicted).toHaveLength(4);
      expect(await rows(racer.tenantId)).toHaveLength(1);

      await purgeTenant(racer.tenantId);
    });
  });

  // ══════════════════════ 5. Expiry — the core claim ═══════════════════════ //

  describe('expiry', () => {
    let clinic: OwnerFixture;

    beforeEach(async () => {
      clinic = track(await createOwnerFixture(e2e, 'fa-expiry'));
      await grant(clinic.tenantId, { durationDays: 45 });
    });
    afterEach(async () => purgeTenant(clinic.tenantId));

    it('is still active with the whole window ahead', async () => {
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(true);
    });

    it('is STILL active one minute before expiry', async () => {
      await advanceClock(clinic.tenantId, 45 * DAY_MS - 60_000);

      expect(await isFreeAccessActive(clinic.tenantId)).toBe(true);
      const d = await decisionFor(clinic.tenantId);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.ADMIN_FREE_ACCESS);
      await http()
        .get(GATED_ROUTE)
        .set(...authHeader(clinic.token))
        .expect(200);
    });

    /**
     * The boundary is `ends_at > now()` — STRICTLY greater. At the instant
     * `now()` reaches `ends_at`, access is over. Shifting by the full duration
     * puts `ends_at` at or a hair behind `now()`, which is exactly that edge.
     */
    it('is INACTIVE at the expiry instant', async () => {
      await advanceClock(clinic.tenantId, 45 * DAY_MS);
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);
    });

    it('is INACTIVE past expiry, and the protected endpoint refuses the clinic', async () => {
      await advanceClock(clinic.tenantId, 46 * DAY_MS);

      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);
      const d = await decisionFor(clinic.tenantId);
      expect(d.allowed).toBe(false);
      expect(d.source).toBe(AccessSource.DENIED);

      await http()
        .get(GATED_ROUTE)
        .set(...authHeader(clinic.token))
        .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    });

    it('reports no active override through the read endpoint once expired', async () => {
      await advanceClock(clinic.tenantId, 46 * DAY_MS);
      const res = await readOverride(clinic.tenantId).expect(200);
      expect(res.body.override).toBeNull();
    });

    /**
     * Expiry is DERIVED, not swept. The row is still `status = 'ACTIVE'` after
     * the deadline — nothing marked it otherwise, because nothing needs to.
     * This is what makes the system correct with no cron running at all, and
     * correct across a backend restart: there is no in-memory timer to lose.
     */
    it('never needed a background job — the row is still ACTIVE, the access is not', async () => {
      await advanceClock(clinic.tenantId, 46 * DAY_MS);

      const [row] = await rows(clinic.tenantId);
      expect(row.status).toBe('ACTIVE');
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);
    });

    /**
     * Survives losing every scrap of cached state — the same position a
     * process is in after a restart, and the position every replica is in when
     * Redis is unavailable and the cache degrades to a cold per-process map.
     * The verdict is recomputed from the row and the database clock.
     */
    it('re-derives the verdict from the row after all cached state is dropped', async () => {
      await advanceClock(clinic.tenantId, 46 * DAY_MS);
      access.invalidate(clinic.tenantId);
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);

      // ...and the reverse direction, so this is not passing by always denying.
      await advanceClock(clinic.tenantId, -46 * DAY_MS);
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(true);
    });

    /**
     * The one case that waits for REAL time. Nothing is touched between the
     * two assertions, so only the clock can explain the change — which rules
     * out a system that merely re-evaluates when written to.
     */
    it('expires by the passage of real time, with the row untouched', async () => {
      await e2e.dataSource.query(
        `UPDATE free_access_overrides
         SET ends_at = now() + interval '1200 milliseconds'
         WHERE tenant_id = $1 AND status = 'ACTIVE'`,
        [clinic.tenantId],
      );
      access.invalidate(clinic.tenantId);

      expect(await isFreeAccessActive(clinic.tenantId)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      access.invalidate(clinic.tenantId); // only the 5s TTL, never the verdict

      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);
      expect((await decisionFor(clinic.tenantId)).allowed).toBe(false);
    }, 20_000);
  });

  // ═══════════ 6. Renew, extend, shorten, revoke — no duplicate rows ═══════ //

  describe('managing an existing grant', () => {
    let clinic: OwnerFixture;

    beforeEach(async () => {
      clinic = track(await createOwnerFixture(e2e, 'fa-manage'));
    });
    afterEach(async () => purgeTenant(clinic.tenantId));

    it('extends the SAME row rather than creating a second grant', async () => {
      await grant(clinic.tenantId, { durationDays: 10 });
      const [before] = await rows(clinic.tenantId);

      await extend(clinic.tenantId, { durationDays: 30 }).expect(200);

      const all = await rows(clinic.tenantId);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(before.id);
      expect(new Date(all[0].ends_at!).getTime()).toBeGreaterThan(
        new Date(before.ends_at!).getTime(),
      );
    });

    it('refuses to extend beyond the maximum in one step', async () => {
      await grant(clinic.tenantId, { durationDays: 10 });
      await extend(clinic.tenantId, {
        durationDays: FREE_ACCESS_MAX_DURATION_DAYS + 1,
      }).expect(400);
    });

    /**
     * SHORTENING is revoke-then-regrant, which is the existing model's answer
     * (`extend` only ever moves the end forward) and the safer one: the
     * shortening is two audited events rather than a silent overwrite.
     */
    it('shortens a grant via revoke + re-grant, leaving one active row', async () => {
      await grant(clinic.tenantId, { durationDays: 200 });
      await revoke(clinic.tenantId).expect(200);
      await grant(clinic.tenantId, { durationDays: 7 }).expect((res) =>
        expect(res.status).toBeLessThan(300),
      );

      expect(await activeRows(clinic.tenantId)).toHaveLength(1);
      const [current] = await activeRows(clinic.tenantId);
      expect(
        Math.round(
          (new Date(current.ends_at!).getTime() -
            new Date(current.starts_at).getTime()) /
            DAY_MS,
        ),
      ).toBe(7);
      // The revoked grant is retained as history, not deleted.
      expect(await rows(clinic.tenantId)).toHaveLength(2);
    });

    it('revoking makes access inactive immediately', async () => {
      await grant(clinic.tenantId, { durationDays: 45 });
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(true);

      await revoke(clinic.tenantId).expect(200);

      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);
      expect((await decisionFor(clinic.tenantId)).allowed).toBe(false);
      await http()
        .get(GATED_ROUTE)
        .set(...authHeader(clinic.token))
        .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    });

    it('refuses to revoke twice', async () => {
      await grant(clinic.tenantId, { durationDays: 45 });
      await revoke(clinic.tenantId).expect(200);
      await revoke(clinic.tenantId).expect(404);
    });

    /**
     * Re-granting after natural expiry must WORK. It is the case a partial
     * unique index on `(tenant_id) WHERE status = 'ACTIVE'` would have broken
     * forever, since an expired grant keeps that status.
     */
    it('allows a fresh grant once the previous one has expired', async () => {
      await grant(clinic.tenantId, { durationDays: 45 });
      await advanceClock(clinic.tenantId, 46 * DAY_MS);
      expect(await isFreeAccessActive(clinic.tenantId)).toBe(false);

      await grant(clinic.tenantId, { durationDays: 30 }).expect((res) =>
        expect(res.status).toBeLessThan(300),
      );

      expect(await isFreeAccessActive(clinic.tenantId)).toBe(true);
      expect(await rows(clinic.tenantId)).toHaveLength(2);
    });
  });

  // ═════════════ 7. A paid subscription is never harmed by expiry ══════════ //

  describe('interaction with a paid subscription', () => {
    let paid: SubscribedOwnerFixture;

    beforeAll(async () => {
      paid = track(
        await createSubscribedOwnerFixture(e2e, 'fa-paid', {}, [GATED_FEATURE]),
      );
      await grant(paid.tenantId, { durationDays: 45 });
    });
    afterAll(async () => {
      await cleanupSubscriptionFixture(e2e, paid.tenantId, paid.planId);
      await purgeTenant(paid.tenantId);
    });

    it('free access outranks the paid subscription while it lasts', async () => {
      const d = await decisionFor(paid.tenantId);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.ADMIN_FREE_ACCESS);
    });

    it('expiring free access FALLS BACK to the paid subscription, never to denial', async () => {
      await advanceClock(paid.tenantId, 46 * DAY_MS);

      const d = await decisionFor(paid.tenantId);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.ACTIVE_SUBSCRIPTION);
      await http()
        .get(GATED_ROUTE)
        .set(...authHeader(paid.token))
        .expect(200);
    });

    it('leaves the subscription row itself completely untouched', async () => {
      const [sub] = await e2e.dataSource.query(
        `SELECT status, ends_at, deleted_at FROM subscriptions WHERE id = $1`,
        [paid.subscriptionId],
      );
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.deleted_at).toBeNull();
      expect(new Date(sub.ends_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('a clinic with NO subscription is denied once free access expires', async () => {
      const bare = track(await createOwnerFixture(e2e, 'fa-nosub'));
      await grant(bare.tenantId, { durationDays: 45 });
      expect((await decisionFor(bare.tenantId)).allowed).toBe(true);

      await advanceClock(bare.tenantId, 46 * DAY_MS);

      const d = await decisionFor(bare.tenantId);
      expect(d.allowed).toBe(false);
      expect(d.source).toBe(AccessSource.DENIED);

      await purgeTenant(bare.tenantId);
    });
  });
});
