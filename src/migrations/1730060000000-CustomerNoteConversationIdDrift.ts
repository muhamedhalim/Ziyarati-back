import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CORRECTIVE. Migration `1730002800000-LiveAgentHandover` added
 * `customer_notes.conversation_id`, a name TypeORM does not actually use.
 *
 * `CustomerNote.conversation` has no explicit `@JoinColumn`, so TypeORM
 * derives the join column from the relation property via its naming
 * strategy, which camel-cases the whole thing (`conversation` + `id` →
 * `conversationId`). The hand-written DDL guessed the snake_case
 * `conversation_id` instead — the same class of bug already fixed once for
 * `integration_conflicts`/`integration_import_jobs`/`integration_sync_jobs`
 * in `1730011000000-IntegrationFixJoinColumnDrift`.
 *
 * WHY THIS WAS NOT CAUGHT EARLIER. The development database is built with
 * `TYPEORM_SYNCHRONIZE=true`, which creates columns from entity metadata —
 * so it always had the CORRECT name and every query worked. Only a database
 * built from the migration chain (production) has the wrong name, and there
 * every read or write touching `customer_notes` fails outright with
 * `column CustomerNote.conversationId does not exist` (mapped to the
 * generic DATABASE_ERROR by `typeorm-error.mapper.ts`, since SQLSTATE 42703
 * has no dedicated branch) — breaking the CRM notes panel entirely on a
 * production-built database.
 *
 * The rename is conditional ON PURPOSE — and this is not the blanket
 * `IF NOT EXISTS` that hides drift. There are exactly two legitimate
 * historical states (built by migrations = wrong name; built by
 * synchronize = right name), and this reconciles them to one. A table with
 * NEITHER column is genuine drift and raises loudly in the post-condition
 * below.
 *
 * ADDITIVE and data-preserving: `ALTER TABLE ... RENAME COLUMN` keeps every
 * row; the existing index (`IDX_customer_notes_conversation`) keeps
 * tracking the column across the rename automatically. Nothing is dropped.
 */
export class CustomerNoteConversationIdDrift1730060000000
  implements MigrationInterface
{
  name = 'CustomerNoteConversationIdDrift1730060000000';

  private static readonly TABLE = 'customer_notes';
  private static readonly WRONG = 'conversation_id';
  private static readonly RIGHT = 'conversationId';

  public async up(q: QueryRunner): Promise<void> {
    const { TABLE, WRONG, RIGHT } =
      CustomerNoteConversationIdDrift1730060000000;

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
   * NOT destructive — no data is lost — but it RE-BREAKS the CRM notes panel
   * against a migration-built database, so there is no reason to run it
   * other than replaying the chain on a throwaway database.
   */
  public async down(q: QueryRunner): Promise<void> {
    const { TABLE, WRONG, RIGHT } =
      CustomerNoteConversationIdDrift1730060000000;

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
