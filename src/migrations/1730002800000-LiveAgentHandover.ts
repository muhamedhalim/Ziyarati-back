import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Live Agent Handover: ownership + timeline additions. All additive/nullable
 * or defaulted — existing rows are unaffected.
 *
 *  - `ai_messages.agent_user_id`: attributes a human-authored `role: 'assistant'`
 *    row (see AiExecutionService/HandoverChatService) without changing how the
 *    AI loads history.
 *  - `conversations.*`: ownership (AI/HUMAN), assignment/release timestamps,
 *    handover reason/notes, transfer count (Inbox "Transferred" tab), and the
 *    assigned agent's last-read timestamp (Inbox "unread" indicator).
 *  - `customer_notes.conversation_id`: ties an internal note to the handover
 *    conversation it was written during (still a first-class CRM note).
 *  - `handover_requests.transferred_from_id` / `notes`: transfer audit trail.
 */
export class LiveAgentHandover1730002800000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "ai_messages" ADD COLUMN IF NOT EXISTS "agent_user_id" uuid`);

    await q.query(`ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "owner_type" varchar(10) NOT NULL DEFAULT 'AI'`);
    await q.query(`ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "assigned_at" timestamptz`);
    await q.query(`ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "released_at" timestamptz`);
    await q.query(`ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "handover_reason" text`);
    await q.query(`ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "handover_notes" text`);
    await q.query(`ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "transfer_count" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "agent_last_read_at" timestamptz`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_owner_type" ON "conversations" ("owner_type")`);

    await q.query(`ALTER TABLE "customer_notes" ADD COLUMN IF NOT EXISTS "conversation_id" uuid`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_customer_notes_conversation" ON "customer_notes" ("conversation_id")`);

    await q.query(`ALTER TABLE "handover_requests" ADD COLUMN IF NOT EXISTS "transferred_from_id" uuid`);
    await q.query(`ALTER TABLE "handover_requests" ADD COLUMN IF NOT EXISTS "notes" text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "handover_requests" DROP COLUMN IF EXISTS "notes"`);
    await q.query(`ALTER TABLE "handover_requests" DROP COLUMN IF EXISTS "transferred_from_id"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_customer_notes_conversation"`);
    await q.query(`ALTER TABLE "customer_notes" DROP COLUMN IF EXISTS "conversation_id"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_conversations_owner_type"`);
    await q.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "agent_last_read_at"`);
    await q.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "transfer_count"`);
    await q.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "handover_notes"`);
    await q.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "handover_reason"`);
    await q.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "released_at"`);
    await q.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "assigned_at"`);
    await q.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "owner_type"`);

    await q.query(`ALTER TABLE "ai_messages" DROP COLUMN IF EXISTS "agent_user_id"`);
  }
}
