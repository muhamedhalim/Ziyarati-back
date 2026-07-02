import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes one `ai_conversations` row serve every channel and carry active session
 * state (Phases 3 + 5). Additive + nullable — no behavioural change to existing
 * rows (channel defaults to API, session is null until the orchestrator writes it).
 */
export class AiConversationChannelSession1730002200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "ai_conversations"
        ADD COLUMN IF NOT EXISTS "channel" character varying(20) NOT NULL DEFAULT 'API',
        ADD COLUMN IF NOT EXISTS "language" character varying(12),
        ADD COLUMN IF NOT EXISTS "session" jsonb
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_conversations_channel" ON "ai_conversations" ("channel")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_ai_conversations_channel"`);
    await q.query(`
      ALTER TABLE "ai_conversations"
        DROP COLUMN IF EXISTS "session",
        DROP COLUMN IF EXISTS "language",
        DROP COLUMN IF EXISTS "channel"
    `);
  }
}
