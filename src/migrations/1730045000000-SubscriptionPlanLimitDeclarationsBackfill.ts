import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfills `subscription_plans.limit_declarations` for PRE-EXISTING rows
 * (Pricing Catalog plan §8/§19 follow-up — root-cause fix for the
 * `ResourcePurchaseService.assertFiniteLimit` "not configured" 422 on
 * `/resource-purchases/preview`).
 *
 * Migration `1730044000000-SubscriptionPlanLimitDeclarations` added the
 * three-state model (`PlanLimitStatusService`: finite / unlimited /
 * not_configured) but only added the `limit_declarations` COLUMN — it never
 * backfilled a value into it. Every plan row that already existed at that
 * point therefore reads as `not_configured` for any limit column left NULL,
 * even though NULL had meant, and — per `UsageService` — STILL means,
 * unlimited at every real enforcement call site (`incrementIfWithinLimit`,
 * `assertResourceWithinLimit`, `assertCountWithinLimit`,
 * `assertUserSeatWithinLimit`, `assertStorageWithinLimit`, `getBreakdown`:
 * every one of them treats `limitRaw === null` as unlimited — see the
 * "unlimited" comments throughout `usage.service.ts`). `not_configured` is
 * ONLY consulted by the newer Phase 2 resource-pricing purchase-preview path
 * (`PlanLimitStatusService` / `assertFiniteLimit`); it never changes what a
 * tenant can actually do.
 *
 * So for any plan that predates this backfill, "not configured" is a false
 * negative in the STATUS metadata, not a true gap in the plan's terms — the
 * plan's owner never had a chance to explicitly declare a column "unlimited"
 * because the declaration mechanism didn't exist yet when the plan was
 * created. This migration closes that gap the same way
 * `1730044000000` intended it to be closed (its own doc comment: "an admin
 * can explicitly DECLARE a NULL limit as intentional"), for every column
 * `PlanAdminService.PLAN_LIMIT_FIELDS` recognizes, on every plan that is, at
 * the moment this migration runs, still NULL and undeclared for that column.
 *
 * This is purely a metadata backfill: it never touches a numeric limit
 * column, and it only fills a `limit_declarations` key that is currently
 * ABSENT — an admin's own later "unlimited" declaration, or a later edit
 * that assigns a finite number, is left completely alone. No tenant's
 * effective limit moves (mirrors `1730044000000`'s own "no subscriber's
 * effective limit moves" guarantee for the identical reason). A plan created
 * AFTER this migration runs, with a column left NULL and undeclared, is
 * unaffected and correctly continues to read as `not_configured` — the
 * warning `PlanLimitStatusService` exists to surface for a genuinely
 * unconfigured NEW plan.
 */

/** Mirrors `PlanAdminService.PLAN_LIMIT_FIELDS`'s `column` values exactly (19 limit columns). */
const PLAN_LIMIT_COLUMNS = [
  'max_branches',
  'max_users',
  'max_ai_tokens',
  'max_whatsapp_messages',
  'max_appointments',
  'max_campaigns',
  'max_ai_requests',
  'max_customers',
  'max_crm_contacts',
  'max_conversations',
  'max_storage_bytes',
  'max_uploaded_files',
  'max_api_calls',
  'max_emails',
  'max_invoices',
  'max_payments',
  'max_transactions',
  'max_knowledge_base_files',
  'max_training_files',
] as const;

export class SubscriptionPlanLimitDeclarationsBackfill1730045000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    for (const column of PLAN_LIMIT_COLUMNS) {
      await q.query(`
        UPDATE "subscription_plans"
           SET "limit_declarations" = COALESCE("limit_declarations", '{}'::jsonb)
                                       || jsonb_build_object('${column}', 'unlimited')
         WHERE "${column}" IS NULL
           AND NOT (COALESCE("limit_declarations", '{}'::jsonb) ? '${column}')
      `);
    }
  }

  /**
   * No-op (R-DB6 pattern, matches `1730044000000`'s own philosophy) — reverting
   * would mean guessing which `limit_declarations` keys this migration added
   * versus ones an admin declared afterward (indistinguishable once merged),
   * and un-declaring a column an admin has since relied on would be a real,
   * observable regression (the catalog's publish-gate coverage badge, and
   * `assertFiniteLimit`'s "already unlimited" vs "not configured" message,
   * would both silently change under an in-use plan). Down leaves the
   * declarations in place; only forward edits via `PlanAdminService` (which
   * always full-replaces `limit_declarations`) change them from here on.
   */
  public async down(): Promise<void> {}
}
