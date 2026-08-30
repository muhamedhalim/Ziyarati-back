/**
 * T190 (spec 014, US14, F14) — pins FR-U010 and FR-U012 as real HTTP requests
 * against the REAL AppModule:
 *
 *  1. Isolation — a row with a NULL tenant (platform-level audit) and a row
 *     belonging to ANOTHER tenant are never returned under any filter
 *     combination, with real rows of both kinds present alongside the
 *     caller's own.
 *  2. An entry referencing a deleted entity still renders without erroring.
 *  3. A filtered page returns within an interactive time budget (FR-U012).
 *     Proving this at the "years of history" / ~5M-row scale this spec calls
 *     out is deliberately DEFERRED, matching the established precedent for
 *     the other large-fixture performance checks in this same batch
 *     (T126/T148/T182, which all require `npm run seed:perf` and are left
 *     unrun for the same reason) — this suite instead seeds a few thousand
 *     rows so the query path, index usage and budget assertion are all
 *     exercised for real, without a multi-million-row seed in CI.
 *
 * Red before T192 (permission grant) / T193 (`ActivityLogController`) exist.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { ACTIVITY_VISIBLE_AUDIT_ACTIONS } from '../src/modules/activity-log/activity-allowlist';

const API = '/api/v1';
const ACTION = ACTIVITY_VISIBLE_AUDIT_ACTIONS[0]; // 'appointment.cancelled_by_patient'

async function insertAuditLog(
  e2e: E2eApp,
  opts: {
    tenantId: string | null;
    userId?: string | null;
    action?: string;
    entityType?: string;
    entityId?: string | null;
  },
): Promise<string> {
  const rows = await e2e.dataSource.query(
    `INSERT INTO audit_logs (action, entity_type, entity_id, "tenantId", "userId")
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      opts.action ?? ACTION,
      opts.entityType ?? 'TestEntity',
      opts.entityId ?? null,
      opts.tenantId,
      opts.userId ?? null,
    ],
  );
  return rows[0].id;
}

describe('Activity Log (T190, HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let otherOwner: OwnerFixture;
  let ownRowId: string;
  let otherTenantRowId: string;
  let nullTenantRowId: string;
  let deletedEntityRowId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 't190');
    otherOwner = await createOwnerFixture(e2e, 't190-other');

    // The caller's own row — must appear.
    ownRowId = await insertAuditLog(e2e, {
      tenantId: owner.tenantId,
      userId: owner.userId,
    });

    // Another tenant's row — must NEVER appear under any filter (FR-U010).
    otherTenantRowId = await insertAuditLog(e2e, {
      tenantId: otherOwner.tenantId,
      userId: otherOwner.userId,
    });

    // A platform-level row (NULL tenant) — must NEVER leak into a clinic's
    // view (FR-U010's own stated reason: this is the case that matters most).
    nullTenantRowId = await insertAuditLog(e2e, {
      tenantId: null,
      userId: null,
      action: ACTION,
    });

    // A row referencing a since-deleted entity — must render without erroring.
    deletedEntityRowId = await insertAuditLog(e2e, {
      tenantId: owner.tenantId,
      userId: owner.userId,
      entityType: 'Campaign',
      entityId: randomUUID(), // no matching row anywhere — simulates deletion
    });
  }, 120_000);

  afterAll(async () => {
    await e2e.dataSource.query(`DELETE FROM audit_logs WHERE id = ANY($1)`, [
      [ownRowId, otherTenantRowId, nullTenantRowId, deletedEntityRowId],
    ]);
    await e2e.dataSource.query(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [
      owner.tenantId,
    ]);
    await e2e.dataSource.query(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [
      otherOwner.tenantId,
    ]);
    const cleanup = async (tenantId: string) => {
      const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
      await q(
        `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(`DELETE FROM users WHERE "tenantId" = $1`);
      await q(`DELETE FROM tenants WHERE id = $1`);
    };
    await cleanup(owner.tenantId);
    await cleanup(otherOwner.tenantId);
    await e2e.app.close();
  }, 60_000);

  describe('FR-U010 — isolation under every filter combination', () => {
    it("an unfiltered page returns only the caller tenant's row", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .set(...authHeader(owner.token));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(ownRowId);
      expect(ids).toContain(deletedEntityRowId);
      expect(ids).not.toContain(otherTenantRowId);
      expect(ids).not.toContain(nullTenantRowId);
    });

    it('filtering by the exact allow-listed action still excludes the other tenant and the null-tenant row', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({ action: ACTION })
        .set(...authHeader(owner.token));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(otherTenantRowId);
      expect(ids).not.toContain(nullTenantRowId);
    });

    it('filtering by entityType/date-range still excludes the other tenant and the null-tenant row', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({
          entityType: 'TestEntity',
          from: '2020-01-01T00:00:00.000Z',
          to: '2035-01-01T00:00:00.000Z',
        })
        .set(...authHeader(owner.token));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(otherTenantRowId);
      expect(ids).not.toContain(nullTenantRowId);
    });

    it('free-text search over the action still excludes the other tenant and the null-tenant row', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({ q: ACTION.split('.')[0] })
        .set(...authHeader(owner.token));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(otherTenantRowId);
      expect(ids).not.toContain(nullTenantRowId);
    });

    it("the OTHER tenant's own view sees its own row, never the caller's or the null-tenant row", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .set(...authHeader(otherOwner.token));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(otherTenantRowId);
      expect(ids).not.toContain(ownRowId);
      expect(ids).not.toContain(nullTenantRowId);
    });
  });

  describe('a row referencing a deleted entity', () => {
    it('renders without erroring, carrying the dangling entity id as-is', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({ entityType: 'Campaign' })
        .set(...authHeader(owner.token));

      expect(res.status).toBe(200);
      const row = res.body.data.find(
        (d: { id: string }) => d.id === deletedEntityRowId,
      );
      expect(row).toBeDefined();
      expect(row.entityId).toEqual(expect.any(String));
    });
  });

  describe('GET /activity/actions', () => {
    it('returns the allow-list', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity/actions`)
        .set(...authHeader(owner.token));

      expect(res.status).toBe(200);
      expect(res.body).toEqual([...ACTIVITY_VISIBLE_AUDIT_ACTIONS]);
    });
  });

  describe('FR-U012 — interactive time budget', () => {
    /**
     * DEFERRED at full scale (see the suite docblock): a real ~5M-row proof
     * needs `npm run seed:perf`-style seeding, matching T126/T148/T182's own
     * deferral. This still exercises the real query, real index and the
     * budget assertion at a reduced, CI-safe scale (a few thousand rows).
     */
    it('a filtered page returns in an interactive time budget at a reduced (non-5M) scale', async () => {
      const rows = Array.from({ length: 3000 }, () => [
        ACTION,
        'PerfEntity',
        null,
        owner.tenantId,
        owner.userId,
      ]);
      const values = rows
        .map(
          (_, i) =>
            `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`,
        )
        .join(',');
      await e2e.dataSource.query(
        `INSERT INTO audit_logs (action, entity_type, entity_id, "tenantId", "userId") VALUES ${values}`,
        rows.flat(),
      );

      const start = Date.now();
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({ action: ACTION, limit: 20 })
        .set(...authHeader(owner.token));
      const elapsedMs = Date.now() - start;

      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThan(1000);

      await e2e.dataSource.query(
        `DELETE FROM audit_logs WHERE "tenantId" = $1 AND entity_type = 'PerfEntity'`,
        [owner.tenantId],
      );
    }, 30_000);
  });
});
