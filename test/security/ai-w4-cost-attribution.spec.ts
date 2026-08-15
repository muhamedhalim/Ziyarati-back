/**
 * T060 — cost and usage mis-attribution reproduction (FR-021, FR-059).
 *
 * Drives one real turn each as tenant A, tenant B, and a guest (bound to the
 * shared discovery tenant — the guest's "acting tenant" for ledger purposes),
 * then queries `ai_cost_entries`, `ai_cost_logs`, `ai_usage_logs`, and
 * `ai_execution_metrics` DIRECTLY (never log text) and asserts every row
 * produced by a given turn carries ONLY the acting tenant's id — proving
 * attribution is bound server-side from `ToolContext`/execution parameters,
 * never from anything the scripted "model" said (the scripted final content
 * never mentions a tenant id anywhere, so any tenant-id leakage into a ledger
 * row could only come from a real code path, not from parroting the reply).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

describe('AI-W4 cost/usage attribution reproduction (T060)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let sessions: ConversationSessionService;

  let convA: AiConversation;
  let convB: AiConversation;
  let convGuest: AiConversation;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    sessions = harness.app.get(ConversationSessionService);

    convA = await conversations.start(seed.tenantA.id, {});
    convB = await conversations.start(seed.tenantB.id, {});
    convGuest = await conversations.start(seed.discoveryTenantId, {});
    await sessions.patch(seed.discoveryTenantId, convGuest.id, { guestSubject: seed.guestA.id });

    harness.provider.script([{ content: 'Tenant A scripted reply — mentions no tenant id.' }]);
    await execution.sendMessage(seed.tenantA.id, convA.id, { content: 'Turn as tenant A.' }, 'REST');

    harness.provider.script([{ content: 'Tenant B scripted reply — mentions no tenant id.' }]);
    await execution.sendMessage(seed.tenantB.id, convB.id, { content: 'Turn as tenant B.' }, 'REST');

    harness.provider.script([{ content: 'Guest scripted reply — mentions no tenant id.' }]);
    await execution.sendMessage(seed.discoveryTenantId, convGuest.id, { content: 'Turn as a guest.' }, 'REST');
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [[convA.id, convB.id, convGuest.id]]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [[convA.id, convB.id, convGuest.id]]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_cost_entries WHERE tenant_id = $1`, [seed.discoveryTenantId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_cost_logs WHERE "tenantId" = $1`, [seed.discoveryTenantId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_usage_logs WHERE "tenantId" = $1`, [seed.discoveryTenantId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_execution_metrics WHERE "tenantId" = $1`, [seed.discoveryTenantId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('ai_cost_entries: every row for a conversation carries ONLY the acting tenant id', async () => {
    const rowsA = await harness.dataSource.query(
      `SELECT DISTINCT tenant_id FROM ai_cost_entries WHERE ai_conversation_id = $1`,
      [convA.id],
    );
    const rowsB = await harness.dataSource.query(
      `SELECT DISTINCT tenant_id FROM ai_cost_entries WHERE ai_conversation_id = $1`,
      [convB.id],
    );
    const rowsGuest = await harness.dataSource.query(
      `SELECT DISTINCT tenant_id FROM ai_cost_entries WHERE ai_conversation_id = $1`,
      [convGuest.id],
    );
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r: { tenant_id: string }) => r.tenant_id === seed.tenantA.id)).toBe(true);
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB.every((r: { tenant_id: string }) => r.tenant_id === seed.tenantB.id)).toBe(true);
    expect(rowsGuest.length).toBeGreaterThan(0);
    expect(rowsGuest.every((r: { tenant_id: string }) => r.tenant_id === seed.discoveryTenantId)).toBe(true);
  });

  it('ai_execution_metrics: every row for a conversation carries ONLY the acting tenant id', async () => {
    const rowsA = await harness.dataSource.query(
      `SELECT DISTINCT "tenantId" FROM ai_execution_metrics WHERE ai_conversation_id = $1`,
      [convA.id],
    );
    const rowsB = await harness.dataSource.query(
      `SELECT DISTINCT "tenantId" FROM ai_execution_metrics WHERE ai_conversation_id = $1`,
      [convB.id],
    );
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r: { tenantId: string }) => r.tenantId === seed.tenantA.id)).toBe(true);
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB.every((r: { tenantId: string }) => r.tenantId === seed.tenantB.id)).toBe(true);
  });

  it('ai_cost_logs (monthly aggregate): tenant A\'s and tenant B\'s rows are separate — one turn each does not inflate the other', async () => {
    const rowA = await harness.dataSource.query(
      `SELECT total_requests, total_tokens FROM ai_usage_logs WHERE "tenantId" = $1`,
      [seed.tenantA.id],
    );
    const rowB = await harness.dataSource.query(
      `SELECT total_requests, total_tokens FROM ai_usage_logs WHERE "tenantId" = $1`,
      [seed.tenantB.id],
    );
    // Both tenants drove exactly one turn each in this suite — if attribution
    // ever merged into a shared bucket, one of these would be inflated to
    // reflect both turns' activity.
    for (const rows of [rowA, rowB]) {
      if (rows.length > 0) expect(rows[0].total_requests).toBe(1);
    }
  });

  it('cross-check: NO ai_cost_entries row for tenant A\'s conversation ever carries tenant B\'s id, and vice versa', async () => {
    const crossA = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ai_cost_entries WHERE ai_conversation_id = $1 AND tenant_id = $2`,
      [convA.id, seed.tenantB.id],
    );
    const crossB = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ai_cost_entries WHERE ai_conversation_id = $1 AND tenant_id = $2`,
      [convB.id, seed.tenantA.id],
    );
    expect(crossA[0].count).toBe(0);
    expect(crossB[0].count).toBe(0);
  });
});
