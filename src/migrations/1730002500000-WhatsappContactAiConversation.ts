import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp inbound AI automation (Feature 3): bind a WhatsApp contact to a single
 * AI conversation so every inbound message from the same number continues the
 * SAME conversation (shared history / session / memory / agent). Nullable +
 * additive — set lazily on the first inbound turn, so existing rows are unchanged.
 */
export class WhatsappContactAiConversation1730002500000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "whatsapp_contacts" ADD COLUMN IF NOT EXISTS "ai_conversation_id" uuid`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_whatsapp_contacts_ai_conversation" ON "whatsapp_contacts" ("ai_conversation_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_whatsapp_contacts_ai_conversation"`);
    await q.query(`ALTER TABLE "whatsapp_contacts" DROP COLUMN IF EXISTS "ai_conversation_id"`);
  }
}
