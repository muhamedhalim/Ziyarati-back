import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CORRECTIVE. Migration `1730071000000-CustomerSegments` created
 * `customer_segments."created_byId"`, a name TypeORM does not use.
 *
 * `CustomerSegment.created_by` has no explicit `@JoinColumn`, so TypeORM
 * derives the join column through its default naming strategy, which
 * camel-cases the whole thing (`created_by` + `Id` → `createdById`). The
 * hand-written DDL guessed the snake_case `created_byId` instead — the same
 * class of bug already fixed for `clinical_entry_revisions`
 * (`1730098000000`), `queue_entries` (`1730083000000`) and `customer_notes`
 * (`1730060000000`).
 *
 * SYMPTOM. On a database built from the migration chain (production) every
 * query that selects a `CustomerSegment` fails with SQLSTATE 42703
 * `column CustomerSegment.createdById does not exist`, which
 * `typeorm-error.mapper.ts` maps to the generic `DATABASE_ERROR` (HTTP 500).
 * That is `GET /crm/segments` — what the Campaigns tab calls to load the
 * audience picker — and also segment create/update/preview/resolve and
 * campaign fan-out for a segment-targeted campaign.
 *
 * WHY IT WAS NOT CAUGHT EARLIER. The development database is built with
 * `TYPEORM_SYNCHRONIZE=true`, which derives columns from entity metadata, so
 * it always had the correct name and every query worked. Verified: the
 * same entity query succeeds on a synchronize-built database and fails with
 * 42703 on one built by running the migrations from scratch. An
 * entity-vs-schema comparison across all 159 entities on a migration-built
 * database found this to be the ONLY missing column.
 *
 * The rename is conditional ON PURPOSE — not a blanket `IF NOT EXISTS` that
 * hides drift. There are exactly two legitimate historical states (built by
 * migrations = wrong name; built by synchronize = right name), and this
 * reconciles them to one. A table with NEITHER column is genuine drift and
 * raises loudly in the post-condition.
 *
 * ADDITIVE and data-preserving: `RENAME COLUMN` keeps every row, and
 * `FK_customer_segments_created_by` follows the column across the rename.
 * Nothing is dropped. A metadata-only change (no table rewrite).
 */
export class CustomerSegmentCreatedByJoinColumnDrift1730117000000
  implements MigrationInterface
{
  name = 'CustomerSegmentCreatedByJoinColumnDrift1730117000000';

  private static readonly TABLE = 'customer_segments';
  private static readonly WRONG = 'created_byId';
  private static readonly RIGHT = 'createdById';

  public async up(q: QueryRunner): Promise<void> {
    const { TABLE, WRONG, RIGHT } =
      CustomerSegmentCreatedByJoinColumnDrift1730117000000;

    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${TABLE}' AND column_name = '${WRONG}'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${TABLE}' AND column_name = '${RIGHT}'
        ) THEN
          ALTER TABLE "${TABLE}" RENAME COLUMN "${WRONG}" TO "${RIGHT}";
        END IF;
      END $$;
    `);

    // Post-condition: the correct column must now exist, and the wrong one
    // must be gone. Neither present is real drift — fail loudly.
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${TABLE}' AND column_name = '${RIGHT}'
        ) THEN
          RAISE EXCEPTION 'Migration post-condition failed: %.% is missing', '${TABLE}', '${RIGHT}';
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${TABLE}' AND column_name = '${WRONG}'
        ) THEN
          RAISE EXCEPTION 'Migration post-condition failed: %.% still exists alongside %', '${TABLE}', '${WRONG}', '${RIGHT}';
        END IF;
      END $$;
    `);
  }

  /**
   * Renames the column back to the (broken) name the original DDL produced.
   * NOT destructive, but it RE-BREAKS `GET /crm/segments` against a
   * migration-built database — only useful for replaying the chain on a
   * throwaway database.
   */
  public async down(q: QueryRunner): Promise<void> {
    const { TABLE, WRONG, RIGHT } =
      CustomerSegmentCreatedByJoinColumnDrift1730117000000;

    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${TABLE}' AND column_name = '${RIGHT}'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${TABLE}' AND column_name = '${WRONG}'
        ) THEN
          ALTER TABLE "${TABLE}" RENAME COLUMN "${RIGHT}" TO "${WRONG}";
        END IF;
      END $$;
    `);
  }
}
