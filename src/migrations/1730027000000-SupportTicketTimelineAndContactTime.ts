import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Support Tickets follow-up: adds the clinic's preferred contact time and an
 * actor-role snapshot on ticket events (so the Super Admin can distinguish a
 * clinic-initiated action from a platform one, reusing the existing event
 * table rather than a new tracking mechanism). Additive; idempotent via
 * ADD COLUMN IF NOT EXISTS. Existing rows get NULL for both columns and keep
 * working unchanged.
 */
export class SupportTicketTimelineAndContactTime1730027000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "support_tickets"
      ADD COLUMN IF NOT EXISTS "preferred_contact_time" TIMESTAMP WITH TIME ZONE
    `);
    await q.query(`
      ALTER TABLE "support_ticket_events"
      ADD COLUMN IF NOT EXISTS "actor_role" character varying(32)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "support_ticket_events" DROP COLUMN IF EXISTS "actor_role"`);
    await q.query(`ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "preferred_contact_time"`);
  }
}
