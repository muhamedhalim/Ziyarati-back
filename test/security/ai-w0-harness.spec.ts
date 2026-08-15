/**
 * W0 smoke test for Feature 011's audit harness + seed fixture (T014/T015).
 *
 * Boots the real `buildAiAuditHarness()`, runs `seedAiAudit()` against the
 * real e2e Postgres, asserts the two guest principals are distinct-but-
 * co-tenant (the exact property every later isolation spec depends on), then
 * tears everything down. This is the harness/seed proof referenced by T014's
 * and T015's "Verify" columns in `specs/011-ai-security-audit/tasks.md`.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';

describe('W0 — AI audit harness + seed smoke test', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
  }, 120_000);

  afterAll(async () => {
    if (seed) await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('boots the harness against the real database', () => {
    expect(harness.app).toBeDefined();
    expect(harness.dataSource.isInitialized).toBe(true);
    expect(harness.pgvectorAvailable).toBe(false); // default (non-pgvector) boot
  });

  it('provisions two distinct tenants, each with an agent, a KB row, 2 customers, staff, and an appointment', () => {
    expect(seed.tenantA.id).not.toBe(seed.tenantB.id);
    for (const t of [seed.tenantA, seed.tenantB]) {
      expect(t.agentId).toBeTruthy();
      expect(t.kbId).toBeTruthy();
      expect(t.customerIds).toHaveLength(2);
      expect(t.staffUserId).toBeTruthy();
      expect(t.staffProfileId).toBeTruthy();
      expect(t.appointmentId).toBeTruthy();
    }
  });

  it('mints two guest principals sharing the discovery tenant with distinct subs', () => {
    expect(seed.guestA.tenantId).toBe(seed.discoveryTenantId);
    expect(seed.guestB.tenantId).toBe(seed.discoveryTenantId);
    expect(seed.guestA.id).not.toBe(seed.guestB.id);
    expect(seed.guestA.guest).toBe(true);
    expect(seed.guestB.guest).toBe(true);
  });

  it('the seeded rows are actually visible in the database (direct-repo writes really landed)', async () => {
    const [[{ count }]] = [
      await harness.dataSource.query(`SELECT COUNT(*)::int AS count FROM tenants WHERE id = ANY($1)`, [
        [seed.tenantA.id, seed.tenantB.id],
      ]),
    ];
    expect(count).toBe(2);
  });

  // Prints the full set of ids this run of seedAiAudit() produced, framed with
  // markers so it is easy to extract from the (verbose, query-logging) jest
  // output — used once to populate `specs/011-ai-security-audit/evidence/raw/
  // seed-manifest.md` per T015's Evidence requirement. Not itself an
  // assertion beyond "the seed returned something at every path".
  it('drives one real turn through the scripted provider and captures the assembled context (T017)', async () => {
    const conversations = harness.app.get(AiConversationService);
    const execution = harness.app.get(AiExecutionService);

    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.script([{ content: 'This is a scripted, deterministic reply. No live provider was called.' }]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'What are your opening hours?' },
      'REST',
    );

    expect(result.message.content).toContain('scripted, deterministic reply');
    expect(harness.provider.callCount).toBeGreaterThanOrEqual(1);
    const captured = harness.provider.capturedMessages(0);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((m) => m.role === 'user')).toBe(true);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('a scripted tool call reaches the dispatcher and is captured (proves the tool-calling seam works end to end)', async () => {
    const conversations = harness.app.get(AiConversationService);
    const execution = harness.app.get(AiExecutionService);

    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    // First turn: the "model" requests a tool the caller is not authorized/scoped for a real result on —
    // this only proves the call round-trips through the dispatcher and back, not any authorization outcome
    // (that is W3's job, not this smoke test's).
    harness.provider.script([
      { toolCalls: [scriptedToolCall('get_clinic_details', { clinicId: seed.tenantB.id })] },
      { content: 'Final scripted answer after the tool call.' },
    ]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Tell me about another clinic.' },
      'REST',
    );

    expect(harness.provider.callCount).toBe(2); // one call that emitted the tool call, one follow-up
    expect(result.message.content).toContain('Final scripted answer');

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('records the seeded id manifest for evidence capture', () => {
    process.stdout.write('\n===SEED-MANIFEST-START===\n');
    process.stdout.write(
      JSON.stringify(
        {
          tenantA: seed.tenantA,
          tenantB: seed.tenantB,
          discoveryTenantId: seed.discoveryTenantId,
          guestA: { id: seed.guestA.id, tenantId: seed.guestA.tenantId, guest: seed.guestA.guest },
          guestB: { id: seed.guestB.id, tenantId: seed.guestB.tenantId, guest: seed.guestB.guest },
        },
        null,
        2,
      ),
    );
    process.stdout.write('\n===SEED-MANIFEST-END===\n');
    expect(seed.tenantA.id).toBeTruthy();
  });
});
