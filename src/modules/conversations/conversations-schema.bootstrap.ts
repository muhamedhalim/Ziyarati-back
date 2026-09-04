import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SchemaGuardRegistry } from '../../config/schema-guard.registry';

/**
 * Idempotently ensures the conversations/messaging integrity + performance
 * schema objects (mirrors the analytics/payments bootstrap pattern; dev runs
 * `synchronize=true` so the migration does not run there). Mirrored by
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
 *
 * ── P0.3 FIX-003: THIS BOOTSTRAP NO LONGER DELETES ROWS ────────────────────
 *
 * It used to run, unconditionally and on EVERY boot in EVERY environment
 * including production:
 *
 *   DELETE FROM messages a USING messages b
 *    WHERE a.ctid > b.ctid AND a."tenantId" = b."tenantId"
 *      AND a.wa_message_id = b.wa_message_id AND a.wa_message_id IS NOT NULL
 *
 * Three things were wrong with that. It destroyed customer message rows to
 * make a `CREATE UNIQUE INDEX` succeed — the "fix the conflict by choosing an
 * arbitrary row" anti-pattern. It chose the survivor by `ctid`, the row's
 * PHYSICAL location, which Postgres changes on any UPDATE and on `VACUUM
 * FULL`, so *which* message survived was not even deterministic. And it was
 * fail-soft, so the row count deleted was never reported anywhere.
 *
 * The replacement counts the conflicts, refuses to touch a single row, and
 * reports through {@link SchemaGuardRegistry} — which logs at ERROR and marks
 * readiness degraded. If duplicates exist the index is genuinely not
 * installable, and resolving them is a business decision (which of two
 * recorded deliveries of the same provider message is real?) that belongs in
 * `tests/load/reports/P0.3_REPAIR_RUNBOOK.md`, not in a boot hook.
 */
@Injectable()
export class ConversationsSchemaBootstrap implements OnApplicationBootstrap {
  private static readonly OWNER = 'ConversationsSchemaBootstrap';

  constructor(
    private readonly dataSource: DataSource,
    private readonly guards: SchemaGuardRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // A DEDICATED connection: this bootstrap runs during the concurrent
    // onApplicationBootstrap phase, and CREATE INDEX statements must not
    // interleave on a shared pooled connection with other bootstraps.
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      // ── H4: inbound message dedup ─────────────────────────────────────────
      await this.requireUnique(runner, {
        label: 'messages wa_message_id unique',
        create: `
          CREATE UNIQUE INDEX IF NOT EXISTS uq_message_wa_id
          ON messages ("tenantId", wa_message_id)
          WHERE wa_message_id IS NOT NULL
        `,
        conflicts: `
          SELECT coalesce(sum(n) - count(*), 0)::bigint AS excess FROM (
            SELECT count(*) AS n FROM messages
             WHERE wa_message_id IS NOT NULL AND "tenantId" IS NOT NULL
             GROUP BY "tenantId", wa_message_id HAVING count(*) > 1) x
        `,
        conflictDetail:
          'Two or more rows in `messages` share (tenantId, wa_message_id) — the same ' +
          'provider message is recorded twice, so an at-least-once WhatsApp webhook ' +
          'retry is NOT being de-duplicated by the database.',
      });

      // ── Inbox sort index (performance only) ───────────────────────────────
      await this.optional(
        runner,
        'conversations inbox index',
        `
        CREATE INDEX IF NOT EXISTS idx_conversations_tenant_lastmsg
        ON conversations ("tenantId", last_message_at)
      `,
      );

      // ── Status-log dedup ──────────────────────────────────────────────────
      await this.requireUnique(runner, {
        label: 'message_status_logs unique',
        create: `
          CREATE UNIQUE INDEX IF NOT EXISTS uq_message_status
          ON message_status_logs ("messageId", status)
        `,
        conflicts: `
          SELECT coalesce(sum(n) - count(*), 0)::bigint AS excess FROM (
            SELECT count(*) AS n FROM message_status_logs
             WHERE "messageId" IS NOT NULL AND status IS NOT NULL
             GROUP BY "messageId", status HAVING count(*) > 1) x
        `,
        conflictDetail:
          'Two or more rows in `message_status_logs` share (messageId, status) — one ' +
          'delivery status is recorded more than once for the same message.',
      });
    } finally {
      await runner.release();
    }
  }

  /**
   * Installs a uniqueness guard, or reports precisely why it cannot be
   * installed. Never deletes, merges or rewrites a row.
   *
   * The pre-check reproduces PostgreSQL's own uniqueness semantics: NULLs are
   * distinct, so a group containing a NULL key column is never a conflict.
   */
  private async requireUnique(
    runner: { query(sql: string): Promise<unknown> },
    spec: {
      label: string;
      create: string;
      conflicts: string;
      conflictDetail: string;
    },
  ): Promise<void> {
    let excess: number | null = null;
    try {
      const rows = (await runner.query(spec.conflicts)) as Array<
        Record<string, unknown>
      >;
      excess = Number(Object.values(rows[0] ?? {})[0] ?? 0);
    } catch {
      // The table may not exist yet on a first boot. Fall through and let the
      // CREATE report the real reason rather than inventing one here.
      excess = null;
    }

    if (excess !== null && excess > 0) {
      this.guards.reportBlocked({
        owner: ConversationsSchemaBootstrap.OWNER,
        label: spec.label,
        criticality: 'required',
        conflicts: excess,
        detail: spec.conflictDetail,
      });
      return;
    }

    await this.guards.ensure({
      owner: ConversationsSchemaBootstrap.OWNER,
      label: spec.label,
      criticality: 'required',
      run: () => runner.query(spec.create),
    });
  }

  /** A performance index. Losing one costs latency, not correctness. */
  private async optional(
    runner: { query(sql: string): Promise<unknown> },
    label: string,
    sql: string,
  ): Promise<void> {
    await this.guards.ensure({
      owner: ConversationsSchemaBootstrap.OWNER,
      label,
      criticality: 'optional',
      run: () => runner.query(sql),
    });
  }
}
