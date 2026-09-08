import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CORRECTIVE. Migration `1730076000000-ClinicalRecords` created
 * `clinical_entry_revisions.changed_byId`, a name TypeORM does not actually
 * use.
 *
 * `ClinicalEntryRevision.changed_by` has no explicit `@JoinColumn`, so
 * TypeORM derives the join column from the relation property via its default
 * naming strategy, which camel-cases the whole thing (`changed_by` + `Id` →
 * `changedById`). The hand-written DDL guessed the snake_case `changed_byId`
 * instead — the same class of bug already fixed for `queue_entries` in
 * `1730083000000-QueueEntryCalledByJoinColumnDrift`, for `customer_notes` in
 * `1730060000000-CustomerNoteConversationIdDrift`, and for
 * `integration_conflicts`/`integration_import_jobs`/`integration_sync_jobs`
 * in `1730011000000-IntegrationFixJoinColumnDrift`.
 *
 * WHY THIS WAS NOT CAUGHT EARLIER. The development database is built with
 * `TYPEORM_SYNCHRONIZE=true`, which creates columns from entity metadata —
 * so it always had the CORRECT name and every query worked. Only a database
 * built from the migration chain (production) has the wrong name, and there
 * `GET /clinical/entries/:id/revisions` (`ClinicalRecordService.listRevisions`,
 * which loads the `changed_by` relation) fails outright with `column
 * ClinicalEntryRevision.changedById does not exist` (mapped to the generic
 * `DATABASE_ERROR` by `typeorm-error.mapper.ts`, since SQLSTATE 42703 has no
 * dedicated branch) — breaking the entry's revision history on a
 * production-built database, regardless of tenant or entry.
 *
 * The rename is conditional ON PURPOSE — and this is not the blanket
 * `IF NOT EXISTS` that hides drift. There are exactly two legitimate
 * historical states (built by migrations = wrong name; built by
 * synchronize = right name), and this reconciles them to one. A table with
 * NEITHER column is genuine drift and raises loudly in the post-condition
 * below.
 *
 * ADDITIVE and data-preserving: `ALTER TABLE ... RENAME COLUMN` keeps every
 * row; `FK_clinical_entry_revisions_changed_by` keeps tracking the column
 * across the rename automatically. Nothing is dropped.
 */
export class ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000
  implements MigrationInterface
{
  name = 'ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000';

  private static readonly TABLE = 'clinical_entry_revisions';
  private static readonly WRONG = 'changed_byId';
  private static readonly RIGHT = 'changedById';

  public async up(q: QueryRunner): Promise<void> {
    const { TABLE, WRONG, RIGHT } =
      ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000;

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
   * NOT destructive — no data is lost — but it RE-BREAKS `GET
   * /clinical/entries/:id/revisions` against a migration-built database, so
   * there is no reason to run it other than replaying the chain on a
   * throwaway database.
   */
  public async down(q: QueryRunner): Promise<void> {
    const { TABLE, WRONG, RIGHT } =
      ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000;

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
