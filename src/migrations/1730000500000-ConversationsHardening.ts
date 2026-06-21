import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Conversations/messaging hardening (mirrors ConversationsSchemaBootstrap):
 *  - H4: partial UNIQUE messages(tenantId, wa_message_id) — inbound webhook dedup
 *  - inbox sort index conversations(tenantId, last_message_at)
 *  - UNIQUE message_status_logs(messageId, status) — status idempotency
 * Idempotent (dedupe-first + IF NOT EXISTS); rollback drops only what it added.
 */
export class ConversationsHardening1730000500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM messages a USING messages b
      WHERE a.ctid > b.ctid
        AND a."tenantId" = b."tenantId"
        AND a.wa_message_id = b.wa_message_id
        AND a.wa_message_id IS NOT NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_message_wa_id
      ON messages ("tenantId", wa_message_id)
      WHERE wa_message_id IS NOT NULL
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_tenant_lastmsg
      ON conversations ("tenantId", last_message_at)
    `);

    await q.query(`
      DELETE FROM message_status_logs a USING message_status_logs b
      WHERE a.ctid > b.ctid
        AND a."messageId" = b."messageId"
        AND a.status = b.status
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_message_status
      ON message_status_logs ("messageId", status)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS uq_message_status`);
    await q.query(`DROP INDEX IF EXISTS idx_conversations_tenant_lastmsg`);
    await q.query(`DROP INDEX IF EXISTS uq_message_wa_id`);
  }
}
