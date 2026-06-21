import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Idempotently ensures the conversations/messaging integrity + performance
 * schema objects (mirrors the analytics/payments bootstrap pattern; dev runs
 * `synchronize=true` so the migration does not run there). Every statement is
 * `IF NOT EXISTS` / dedupe-first / fail-soft, and is mirrored by
 * `1730000500000-ConversationsHardening.ts` for migrations-first prod.
 *
 *  - H4: partial UNIQUE on `messages (tenantId, wa_message_id)` so an
 *    at-least-once inbound webhook (WhatsApp retry) can't insert the same
 *    provider message twice (the insert path catches 23505 → idempotent).
 *  - Inbox scale: `(tenantId, last_message_at)` index for the inbox sort
 *    (`conversation.service.findAll` orders by last_message_at DESC).
 *  - Status integrity: UNIQUE `(messageId, status)` on `message_status_logs` so
 *    a delivery status can be recorded at most once (backstops the monotonic
 *    transition guard against the concurrent-webhook read-then-write race).
 *
 * FK columns follow TypeORM's default camelCase naming (`"tenantId"`,
 * `"messageId"`).
 */
@Injectable()
export class ConversationsSchemaBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('ConversationsSchemaBootstrap');

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    // A DEDICATED connection: this bootstrap runs during the concurrent
    // onApplicationBootstrap phase, and CREATE INDEX / DELETE statements must not
    // interleave on a shared pooled connection with other bootstraps.
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      // ── H4: inbound message dedup (dedupe THEN partial unique) ─────────────
      await this.run(runner, 'messages wa_message_id dedupe', `
        DELETE FROM messages a USING messages b
        WHERE a.ctid > b.ctid
          AND a."tenantId" = b."tenantId"
          AND a.wa_message_id = b.wa_message_id
          AND a.wa_message_id IS NOT NULL
      `);
      await this.run(runner, 'messages wa_message_id unique', `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_message_wa_id
        ON messages ("tenantId", wa_message_id)
        WHERE wa_message_id IS NOT NULL
      `);

      // ── Inbox sort index ───────────────────────────────────────────────────
      await this.run(runner, 'conversations inbox index', `
        CREATE INDEX IF NOT EXISTS idx_conversations_tenant_lastmsg
        ON conversations ("tenantId", last_message_at)
      `);

      // ── Status-log dedup (dedupe THEN unique) ──────────────────────────────
      await this.run(runner, 'message_status_logs dedupe', `
        DELETE FROM message_status_logs a USING message_status_logs b
        WHERE a.ctid > b.ctid
          AND a."messageId" = b."messageId"
          AND a.status = b.status
      `);
      await this.run(runner, 'message_status_logs unique', `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_message_status
        ON message_status_logs ("messageId", status)
      `);
    } finally {
      await runner.release();
    }
  }

  private async run(runner: { query(sql: string): Promise<unknown> }, label: string, sql: string): Promise<void> {
    try {
      await runner.query(sql);
    } catch (err) {
      this.logger.warn(`Skipped "${label}": ${(err as Error).message}`);
    }
  }
}
