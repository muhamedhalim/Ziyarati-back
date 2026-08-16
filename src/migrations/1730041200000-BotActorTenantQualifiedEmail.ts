import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M3 (`AI-001`, R10, Clarification Q1) — rewrites any pre-existing WhatsApp AI
 * bot-actor row still at the bare legacy address `ai-bot@bot.internal` to the
 * RFC 5233 sub-addressed, tenant-qualified form `ai-bot+<tenantId>@bot.internal`
 * that `WhatsappBotActorService.botEmailFor()` now derives and looks up.
 *
 * WHY: `users.email` is unique GLOBALLY (`uq_user_email_global`, migration
 * `1730035000000`), not per tenant. The bare literal could therefore only
 * ever belong to one tenant at a time — every other tenant's first inbound
 * WhatsApp AI message failed `ensureBotActor()` with a unique-violation. This
 * migration is DATA-ONLY: no schema change, `uq_user_email_global` untouched.
 *
 * IDEMPOTENT: selects only rows still at the bare legacy literal — after the
 * first successful run (or on a database that never held one), the selection
 * is empty and this is a harmless no-op, including on repeat runs.
 *
 * The qualified address is derived from each row's OWN `tenantId` column,
 * never from a migration parameter — this can only ever confirm and rewrite
 * legitimate existing state, and matches the identical derivation the
 * application code performs at read time.
 *
 * FR-002a: if a tenant somehow already holds BOTH a legacy-addressed row and
 * a qualified-addressed row (an unexpected, contradictory state — how would
 * a second row have gotten the qualified address before this migration ran?),
 * this migration refuses to guess which one is authoritative and fails loudly.
 */
export class BotActorTenantQualifiedEmail1730041200000 implements MigrationInterface {
  name = 'BotActorTenantQualifiedEmail1730041200000';

  private static readonly LEGACY_EMAIL = 'ai-bot@bot.internal';

  private static qualifiedEmail(tenantId: string): string {
    return `ai-bot+${tenantId}@bot.internal`;
  }

  public async up(q: QueryRunner): Promise<void> {
    const legacyRows: { id: string; tenantId: string | null }[] = await q.query(
      `SELECT "id", "tenantId" FROM "users" WHERE "email" = $1`,
      [BotActorTenantQualifiedEmail1730041200000.LEGACY_EMAIL],
    );

    for (const row of legacyRows) {
      // A legacy bot row with no tenant would be a pre-existing data anomaly
      // unrelated to this finding (the bot actor is always tenant-created) —
      // not something this migration should guess about.
      if (!row.tenantId) {
        throw new Error(
          `M3: legacy bot row ${row.id} has no tenantId — refusing to guess ` +
            'a tenant-qualified address for it. Resolve manually before re-running.',
        );
      }

      const qualified =
        BotActorTenantQualifiedEmail1730041200000.qualifiedEmail(row.tenantId);

      const conflicting: { id: string }[] = await q.query(
        `SELECT "id" FROM "users" WHERE "email" = $1 AND "id" != $2`,
        [qualified, row.id],
      );
      if (conflicting.length > 0) {
        throw new Error(
          `M3: tenant ${row.tenantId} already holds a qualified-address bot row ` +
            `(${conflicting[0].id}) in addition to the legacy row ${row.id} — ` +
            'refusing to guess which is authoritative. Resolve manually before re-running.',
        );
      }

      await q.query(`UPDATE "users" SET "email" = $1 WHERE "id" = $2`, [
        qualified,
        row.id,
      ]);
    }
  }

  /**
   * Restores the legacy address for exactly the rows whose email is the
   * qualified form THIS migration derives from their own tenant id — never a
   * broader `LIKE` match that could catch an unrelated address. Refuses up
   * front (rather than failing partway through, mid-revert) if more than one
   * such row exists: reverting more than one to the same bare literal would
   * itself recreate the `uq_user_email_global` collision this feature exists
   * to fix, so guessing an order to apply them in is exactly the wrong move.
   */
  public async down(q: QueryRunner): Promise<void> {
    const qualifiedRows: { id: string; tenantId: string }[] = await q.query(
      `SELECT "id", "tenantId" FROM "users"
       WHERE "tenantId" IS NOT NULL
         AND "email" = 'ai-bot+' || "tenantId"::text || '@bot.internal'`,
    );

    if (qualifiedRows.length > 1) {
      throw new Error(
        `M3 rollback refused: ${qualifiedRows.length} tenant-qualified bot rows exist ` +
          '(would collide on the shared legacy literal address if all were reverted). ' +
          'Resolve manually — revert at most one, or leave the rest qualified.',
      );
    }

    for (const row of qualifiedRows) {
      await q.query(`UPDATE "users" SET "email" = $1 WHERE "id" = $2`, [
        BotActorTenantQualifiedEmail1730041200000.LEGACY_EMAIL,
        row.id,
      ]);
    }
  }
}
