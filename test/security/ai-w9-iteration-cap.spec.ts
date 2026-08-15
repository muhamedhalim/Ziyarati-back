/**
 * T140 — tool-iteration-cap reproduction (FR-061, FR-073).
 *
 * `AiExecutionService`'s tool-calling loop is bounded by `MAX_TOOL_ITERATIONS = 4`
 * (`src/modules/ai/ai-execution.service.ts:63`). This spec drives a real turn
 * where the scripted "model" requests a tool call on every iteration (never
 * returning a plain answer), so the loop is forced to run out its budget, and:
 *
 *  1. proves the dispatcher is invoked AT MOST 4 times in that single turn
 *     (never a 5th, even though a 5th scripted turn is queued and available);
 *  2. inspects what content is returned to the caller when the cap is hit;
 *  3. proves the cap resets on every NEW inbound message (`sendMessage` call),
 *     i.e. it bounds tool calls PER TURN, not cumulatively across a
 *     conversation — a client that keeps sending trivial follow-up messages
 *     can drive unbounded total tool calls, 4 at a time, forever.
 *
 * Uses `search_clinics` (`AI_TOOL.SEARCH_CLINICS`) — a read-only, cross-tenant
 * discovery tool whose idempotency key is `search_clinics:${randomUUID()}`
 * (`ai-tool-dispatch.service.ts:302-314`), i.e. NEVER deduplicated — so every
 * loop iteration's tool call is a fresh, independently-ledgered row, letting a
 * raw `ai_tool_calls` count directly prove how many iterations actually ran.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';

describe('AI tool-iteration cap (T140) — MAX_TOOL_ITERATIONS = 4', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;

  const searchClinicsCall = () => scriptedToolCall('search_clinics', {});

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('a model that ALWAYS requests a tool call is stopped after exactly 4 iterations, and a 5th queued turn is never consumed', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    // 5 turns queued, every one a forced tool call. If the cap is respected,
    // only the first 4 are ever consumed.
    harness.provider.script([
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
      { content: 'UNREACHABLE — this 5th scripted turn must never be consumed.' },
    ]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Keep searching forever.' },
      'REST',
    );

    // 1) Exactly 4 provider round-trips — never a 5th.
    expect(harness.provider.callCount).toBe(4);

    // 2) Exactly 4 tool-call ledger rows for this conversation (each
    //    search_clinics call is independently keyed — no idempotency replay
    //    could be masking a lower real count).
    const [{ count }] = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ai_tool_calls WHERE ai_conversation_id = $1 AND tool_name = 'search_clinics'`,
      [conv.id],
    );
    expect(count).toBe(4);

    // 3) What is returned to the caller at the cap: NOT the unreachable 5th
    //    turn's content, and NOT a real synthesized answer — the last
    //    iteration's own (empty, since it was a tool-call turn) content is
    //    replaced by the hardcoded fallback string
    //    (`ai-execution.service.ts:441-443`). The model's tool-call requests
    //    and their real results are silently dropped from the reply — the
    //    caller has no way to tell from the final answer alone that 4 tool
    //    calls actually executed.
    expect(result.message.content).toBe('I have processed your request.');
    expect(result.message.content).not.toContain('UNREACHABLE');

    process.stdout.write('\n===ITERATION-CAP-SINGLE-TURN===\n');
    process.stdout.write(
      JSON.stringify(
        { providerCalls: harness.provider.callCount, toolCallRows: count, finalContent: result.message.content },
        null,
        2,
      ) + '\n',
    );
  }, 30_000);

  it('the cap is PER TURN, not cumulative: a second inbound message on the SAME conversation gets its own fresh 4-iteration budget', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});

    // Turn 1: exhaust the cap.
    harness.provider.reset();
    harness.provider.script([
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
    ]);
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: 'Turn 1.' }, 'REST');
    expect(harness.provider.callCount).toBe(4);

    // Turn 2 (a distinct sendMessage call, as a follow-up user message would
    // trigger): scripted with another 4 forced tool calls. If the cap were
    // cumulative across the conversation, this would be refused or truncated
    // immediately (0 further iterations available). It is not — it runs a
    // full fresh 4 again.
    harness.provider.reset();
    harness.provider.script([
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
      { toolCalls: [searchClinicsCall()] },
    ]);
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: 'Turn 2.' }, 'REST');
    expect(harness.provider.callCount).toBe(4);

    const [{ count }] = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ai_tool_calls WHERE ai_conversation_id = $1 AND tool_name = 'search_clinics'`,
      [conv.id],
    );
    // 4 (turn 1) + 4 (turn 2) = 8 real tool executions on ONE conversation —
    // double MAX_TOOL_ITERATIONS. The cap bounds a single turn's loop only;
    // it is trivially "circumvented" (not a bypass of a check, but a design
    // property never advertised as a conversation-wide bound) by chaining
    // additional inbound messages, each of which is a legitimate, ordinary
    // client action (no forged token, no malformed request needed).
    expect(count).toBe(8);

    process.stdout.write('\n===ITERATION-CAP-CHAINED-TURNS===\n');
    process.stdout.write(JSON.stringify({ conversationId: conv.id, totalToolCallRows: count }, null, 2) + '\n');
  }, 30_000);
});
