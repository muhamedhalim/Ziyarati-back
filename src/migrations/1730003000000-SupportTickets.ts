import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Support Tickets: tenant-raised tickets triaged by platform super-admins, plus
 * an append-only event log (status/priority changes + internal admin notes).
 * `support_ticket_number_seq` backs the backend-generated `TKT-NNNNNN` ticket
 * number (never client-supplied). Additive; idempotent via IF NOT EXISTS.
 */
export class SupportTickets1730003000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE SEQUENCE IF NOT EXISTS "support_ticket_number_seq" START WITH 1000`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "support_tickets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "ticket_number" character varying(20) NOT NULL,
        "subject" character varying(200) NOT NULL,
        "category" character varying(24) NOT NULL,
        "priority" character varying(16) NOT NULL,
        "status" character varying(24) NOT NULL DEFAULT 'open',
        "description" text NOT NULL,
        "attachment_key" character varying,
        "attachment_filename" character varying(255),
        "attachment_mime_type" character varying(100),
        "attachment_size" integer,
        "createdById" uuid,
        "created_by_name" character varying(160),
        "created_by_email" character varying(255),
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_tickets" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_support_tickets_ticket_number" UNIQUE ("ticket_number"),
        CONSTRAINT "FK_support_tickets_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_support_tickets_created_by" FOREIGN KEY ("createdById")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_tickets_tenant" ON "support_tickets" ("tenantId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_tickets_status" ON "support_tickets" ("status")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_tickets_priority" ON "support_tickets" ("priority")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_tickets_category" ON "support_tickets" ("category")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_tickets_created_at" ON "support_tickets" ("created_at")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "support_ticket_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ticketId" uuid NOT NULL,
        "type" character varying(24) NOT NULL,
        "from_value" character varying(32),
        "to_value" character varying(32),
        "note" text,
        "internal_only" boolean NOT NULL DEFAULT false,
        "actorId" uuid,
        "actor_name" character varying(160),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_ticket_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_support_ticket_events_ticket" FOREIGN KEY ("ticketId")
          REFERENCES "support_tickets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_support_ticket_events_actor" FOREIGN KEY ("actorId")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_ticket_events_ticket" ON "support_ticket_events" ("ticketId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_ticket_events_created_at" ON "support_ticket_events" ("created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "support_ticket_events"`);
    await q.query(`DROP TABLE IF EXISTS "support_tickets"`);
    await q.query(`DROP SEQUENCE IF EXISTS "support_ticket_number_seq"`);
  }
}
