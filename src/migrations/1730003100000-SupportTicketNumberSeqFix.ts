import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fix-forward: guarantees `support_ticket_number_seq` exists.
 *
 * Root cause: in any environment where `TYPEORM_SYNCHRONIZE=true` (local dev),
 * `migrationsRun` is forced to `false` (`typeorm.config.ts`: `migrationsRun:
 * !synchronize`), so the original `SupportTickets` migration
 * (`1730003000000-SupportTickets.ts`) never executes — `synchronize` only
 * creates schema from entity metadata (tables/columns/indexes), and a bare
 * `CREATE SEQUENCE` has no entity-level representation, so it's silently never
 * created. The tables it creates (`support_tickets`, `support_ticket_events`)
 * exist fine via `synchronize`; only the sequence was missing, which is what
 * `SupportTicketService.nextTicketNumber()` calls via `nextval(...)`.
 *
 * This migration does not alter the original — it only guarantees the
 * sequence exists, via `IF NOT EXISTS`, so it's a safe no-op anywhere the
 * original migration already created it (e.g. staging/production, where
 * `synchronize` is never enabled).
 */
export class SupportTicketNumberSeqFix1730003100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE SEQUENCE IF NOT EXISTS "support_ticket_number_seq" START WITH 1000`,
    );
  }

  public async down(_q: QueryRunner): Promise<void> {
    // Ownership of the sequence's lifecycle stays with the original
    // SupportTickets migration's down() — nothing to undo here.
  }
}
