import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CR-05 - the public Contact Us form had no backend route. This adds the table that stores its
 * enquiries.
 *
 * EXPAND-only: a brand-new table nothing else references. Old code never touches it, so a rolling
 * deploy is safe in either order. Idempotent (`IF NOT EXISTS`) so it is a no-op on a database that
 * `synchronize` already shaped in development.
 */
export class ContactLeads1730125000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "contact_leads" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "full_name" character varying(255) NOT NULL,
        "email" character varying(254) NOT NULL,
        "phone" character varying(20),
        "facility_name" character varying(255),
        "subject" character varying(16) NOT NULL,
        "message" text NOT NULL,
        "locale" character varying(8) NOT NULL DEFAULT 'en',
        "status" character varying(16) NOT NULL DEFAULT 'new',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_contact_leads" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_contact_leads_subject"
          CHECK ("subject" IN ('demo','pricing','support','partnership','other')),
        CONSTRAINT "CHK_contact_leads_status" CHECK ("status" IN ('new','handled'))
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_contact_leads_status_created" ON "contact_leads" ("status", "created_at")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_contact_leads_email_created" ON "contact_leads" ("email", "created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "contact_leads"`);
  }
}
