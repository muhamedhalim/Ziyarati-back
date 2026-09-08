import { MigrationInterface, QueryRunner } from 'typeorm';
import { slugify } from '../common/utils/slugify.util';

/**
 * Marketplace BE-4 (T065) — `services.public_slug`: a stable identifier for
 * the clinic-scoped `/clinics/[clinicSlug]/services/[serviceSlug]` route.
 * Unique per `(tenantId, public_slug)`, not globally — the detail URL is
 * already clinic-scoped, so two different clinics may both have a
 * `teeth-cleaning` service. Added nullable first, backfilled, then
 * tightened — the same safe-column-addition shape as T060's
 * `StaffPublicSlug1730096000000`.
 *
 * Backfill: name-derived (`services.name`) via the same `slugify()` the live
 * `ServiceService` uses for new rows, with deterministic numeric
 * disambiguation tracked **per tenant** (not globally) across the pass, so
 * two colliding names in the same clinic never both claim the base slug,
 * while identically-named services in different clinics both keep the
 * un-suffixed base.
 */
export class ServicePublicSlug1730097000000 implements MigrationInterface {
  name = 'ServicePublicSlug1730097000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "public_slug" varchar(160)`,
    );

    const rows: { id: string; tenantId: string; name: string }[] =
      await q.query(
        `SELECT id, "tenantId", name FROM "services" WHERE "public_slug" IS NULL ORDER BY created_at ASC`,
      );

    if (rows.length > 0) {
      const existing: { tenantId: string; public_slug: string }[] =
        await q.query(
          `SELECT "tenantId", "public_slug" FROM "services" WHERE "public_slug" IS NOT NULL`,
        );
      const takenByTenant = new Map<string, Set<string>>();
      for (const row of existing) {
        if (!takenByTenant.has(row.tenantId)) {
          takenByTenant.set(row.tenantId, new Set());
        }
        takenByTenant.get(row.tenantId)!.add(row.public_slug);
      }

      for (const row of rows) {
        if (!takenByTenant.has(row.tenantId)) {
          takenByTenant.set(row.tenantId, new Set());
        }
        const taken = takenByTenant.get(row.tenantId)!;
        const base = slugify(row.name, 'service');
        let candidate = base;
        let n = 2;
        while (taken.has(candidate)) {
          candidate = `${base}-${n}`;
          n += 1;
        }
        taken.add(candidate);
        await q.query(
          `UPDATE "services" SET "public_slug" = $1 WHERE id = $2`,
          [candidate, row.id],
        );
      }
    }

    const [{ c: stillNull }] = (await q.query(
      `SELECT COUNT(*)::int AS c FROM "services" WHERE "public_slug" IS NULL`,
    )) as [{ c: number }];
    if (Number(stillNull) > 0) {
      throw new Error(
        `${ServicePublicSlug1730097000000.name}: ${stillNull} services row(s) still have a NULL ` +
          'public_slug after the backfill loop — investigate before tightening the column.',
      );
    }

    await q.query(
      `ALTER TABLE "services" ALTER COLUMN "public_slug" SET NOT NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_services_tenant_public_slug" ON "services" ("tenantId", "public_slug")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "public"."UQ_services_tenant_public_slug"`,
    );
    await q.query(
      `ALTER TABLE "services" ALTER COLUMN "public_slug" DROP NOT NULL`,
    );
    await q.query(`ALTER TABLE "services" DROP COLUMN IF EXISTS "public_slug"`);
  }
}
