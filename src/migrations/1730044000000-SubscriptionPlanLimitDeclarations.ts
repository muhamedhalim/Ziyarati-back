import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 0.2 (Pricing Catalog plan §8) — the three-state plan-limit model.
 *
 * A `NULL` plan limit column has meant "unlimited" at ~20 call sites since
 * the plan was written, and the admin UI renders `∞` into an empty input —
 * indistinguishable from a column nobody has configured yet. This adds ONE
 * additive, nullable column so an admin can explicitly DECLARE a NULL limit
 * as intentional:
 *
 *   { "max_customers": "unlimited", "max_branches": "unlimited" }
 *
 * Resolved into Finite / Unlimited (declared) / Not configured by
 * `PlanLimitStatusService`. Deliberately NOT added to `toTermPatch` — an
 * in-use plan may still have this declared/edited at any time, because
 * declaring a NULL limit unlimited documents existing behaviour rather than
 * changing it (no tenant's effective limit moves). It IS added to
 * `snapshot()` so the change is audited.
 */
export class SubscriptionPlanLimitDeclarations1730044000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "subscription_plans"
      ADD COLUMN IF NOT EXISTS "limit_declarations" jsonb
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "subscription_plans"
      DROP COLUMN IF EXISTS "limit_declarations"
    `);
  }
}
