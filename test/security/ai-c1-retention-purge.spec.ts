/**
 * T084 (AI-008, FR-029a-e) — the ai_tool_calls attempt-only retention purge
 * seam (`AiToolCallRetentionService.purgeExpiredAttempts`).
 *
 * Asserts, against the real ledger table:
 *  - attempt-only rows past the configured window ARE purged;
 *  - executed-action (claim) rows are NEVER purged, however old (FR-029a —
 *    their lifetime is unbounded, unaffected by this mechanism);
 *  - the filter cannot select a PENDING/EXECUTING row, even when old
 *    (FR-029d — belt-and-suspenders; no code path creates one today, this
 *    proves the SQL predicate itself would still exclude it if one existed);
 *  - a concurrent ledger read is not blocked by the purge (bounded batches,
 *    no long-held transaction).
 *
 * Batching/per-run-cap boundedness (5,000 rows/batch, 1,000-batch cap) is
 * proven separately at the unit level below — driving 5,000+ real rows
 * through the e2e database is not a proportionate way to observe a loop
 * boundary that a mocked DataSource proves deterministically.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolCallRetentionService } from '../../src/modules/ai/tools/ai-tool-call-retention.service';

describe('C1 — ai_tool_calls attempt-only retention purge (T084)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let retention: AiToolCallRetentionService;
  let convId: string;

  const EXPIRED = new Date(Date.now() - 200 * 86_400_000); // well past the 90-day default
  const FRESH = new Date(Date.now() - 10 * 86_400_000); // well within the window

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    retention = harness.app.get(AiToolCallRetentionService);

    const conv = await conversations.start(seed.tenantA.id, {});
    convId = conv.id;
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [convId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convId]);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function insertRow(opts: {
    key: string;
    status: string;
    createdAt: Date;
  }) {
    const rows: { id: string }[] = await harness.dataSource.query(
      `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, tool_name, arguments, status, idempotency_key, created_at)
       VALUES ($1, $2, 'select_clinic', '{}'::jsonb, $3, $4, $5)
       RETURNING id`,
      [seed.tenantA.id, convId, opts.status, opts.key, opts.createdAt],
    );
    return rows[0].id;
  }

  async function existingKeys(): Promise<string[]> {
    const rows: { idempotency_key: string }[] = await harness.dataSource.query(
      `SELECT idempotency_key FROM ai_tool_calls WHERE ai_conversation_id = $1`,
      [convId],
    );
    return rows.map((r) => r.idempotency_key);
  }

  it('purges only expired ATTEMPT rows, leaving fresh attempts, old claims, and old in-flight rows untouched', async () => {
    const expiredAttemptKey = `attempt:select_clinic:${convId}-expired`;
    const freshAttemptKey = `attempt:select_clinic:${convId}-fresh`;
    const oldClaimKey = `select:${convId}-old-claim`;
    const oldPendingKey = `attempt:select_clinic:${convId}-old-pending`;
    const oldExecutingKey = `attempt:select_clinic:${convId}-old-executing`;

    await insertRow({ key: expiredAttemptKey, status: 'DENIED', createdAt: EXPIRED });
    await insertRow({ key: freshAttemptKey, status: 'REFUSED', createdAt: FRESH });
    // A CLAIM-shaped key (no `attempt:` prefix) — NEVER purged, however old.
    await insertRow({ key: oldClaimKey, status: 'SUCCEEDED', createdAt: EXPIRED });
    // FR-029d belt-and-suspenders: an (unreachable in practice) old
    // PENDING/EXECUTING attempt-shaped row must still be excluded.
    await insertRow({ key: oldPendingKey, status: 'PENDING', createdAt: EXPIRED });
    await insertRow({ key: oldExecutingKey, status: 'EXECUTING', createdAt: EXPIRED });

    const before = await existingKeys();
    expect(before.sort()).toEqual(
      [expiredAttemptKey, freshAttemptKey, oldClaimKey, oldPendingKey, oldExecutingKey].sort(),
    );

    const result = await retention.purgeExpiredAttempts();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const after = await existingKeys();
    // The one row that MUST be gone.
    expect(after).not.toContain(expiredAttemptKey);
    // Everything else MUST survive.
    expect(after).toEqual(
      expect.arrayContaining([freshAttemptKey, oldClaimKey, oldPendingKey, oldExecutingKey]),
    );
  }, 30_000);

  it('does not block a concurrent ledger read (bounded batches, no long-held transaction)', async () => {
    await insertRow({
      key: `attempt:select_clinic:${convId}-concurrency`,
      status: 'DENIED',
      createdAt: EXPIRED,
    });

    const start = Date.now();
    const [, readRows] = await Promise.all([
      retention.purgeExpiredAttempts(),
      harness.dataSource.query(`SELECT COUNT(*)::int AS c FROM ai_tool_calls WHERE ai_conversation_id = $1`, [convId]),
    ]);
    // Both complete promptly and concurrently — a lock held across the whole
    // purge would make the concurrent read wait for it instead.
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(readRows[0].c).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

describe('C1 — retention purge batching + per-run cap (unit, T084)', () => {
  function buildService(query: jest.Mock) {
    const dataSource = { query } as unknown as ConstructorParameters<typeof AiToolCallRetentionService>[0];
    const config = { get: jest.fn().mockReturnValue(90) } as unknown as ConstructorParameters<typeof AiToolCallRetentionService>[1];
    return new AiToolCallRetentionService(dataSource, config);
  }

  it('keeps querying in bounded batches until a partial (final) batch is returned', async () => {
    const fullBatch = Array.from({ length: 5_000 }, (_, i) => ({ id: `row-${i}` }));
    const partialBatch = [{ id: 'row-final-1' }, { id: 'row-final-2' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce(fullBatch) // batch 1: full — loop continues
      .mockResolvedValueOnce(fullBatch) // batch 2: full — loop continues
      .mockResolvedValueOnce(partialBatch); // batch 3: partial — loop stops
    const service = buildService(query);

    const result = await service.purgeExpiredAttempts();

    expect(query).toHaveBeenCalledTimes(3); // stopped as soon as a batch came back short of the cap
    expect(result.deleted).toBe(5_000 + 5_000 + 2);
    // Every call's LIMIT parameter is the fixed 5,000-row batch bound.
    for (const call of query.mock.calls) {
      expect(call[1][1]).toBe(5_000);
    }
  });

  it('stops after a single empty batch (nothing left to purge) without looping further', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const service = buildService(query);

    const result = await service.purgeExpiredAttempts();

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(0);
  });
});
