/**
 * T149 — tool-loop / recursive-agent abuse (FR-070, FR-073).
 *
 * Scripts the provider to emit unbounded repeated and mutually-recursive
 * tool calls and asserts the observed iteration ceiling
 * (`MAX_TOOL_ITERATIONS = 4`, `ai-execution.service.ts:63`) and the total
 * number of provider calls issued per turn. Also probes the ceiling's OTHER
 * axis, per-iteration fan-out (how many tool calls one scripted turn may
 * request) — [PROMOTED, RTP row 19, AI-023/T108-T111] now independently
 * bounded by `AI_MAX_TOOL_CALLS_PER_ITERATION`, never by
 * `MAX_TOOL_ITERATIONS` (which still bounds ROUNDS, unchanged).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';

const MAX_TOOL_ITERATIONS = 4; // ai-execution.service.ts — mirrored here as the expected value, not re-derived
const WRAP_UP_CALLS = 1; // F-15: one tool-less completion after the last tool round, so a turn is at most 5 provider calls

describe('AI abuse — tool-loop and recursive-agent bounds (T149)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;

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

  it('an attacker-controlled model that ALWAYS returns a tool call (never a plain answer) is stopped at exactly MAX_TOOL_ITERATIONS tool rounds plus one tool-less wrap-up, not one more, not fewer', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    // Script far more turns than the cap could ever consume — every single
    // one requests a tool call, so if the cap did not exist the loop would
    // run until the queue (10 turns) or forever (via the provider's own
    // "no further turns queued" default, which is itself a plain answer, so
    // we deliberately over-supply tool-call turns to prove the CAP, not the
    // queue length, is what stops it).
    harness.provider.script(
      Array.from({ length: 10 }, (_, i) => ({
        toolCalls: [scriptedToolCall('get_clinic_details', { probe: `loop-${i}` })],
      })),
    );

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Trigger an unbounded tool-call loop.' },
      'REST',
    );

    // Exactly MAX_TOOL_ITERATIONS + 1 provider.complete() calls — the loop body
    // runs `for (i = 0; i <= MAX_TOOL_ITERATIONS; i++)`; the last iteration is the
    // tool-less wrap-up, so the cost of a runaway turn is bounded at 5 calls.
    expect(harness.provider.callCount).toBe(MAX_TOOL_ITERATIONS + WRAP_UP_CALLS);
    // The cap's own fallback content (F-15: no longer the canned "I have
    // processed your request."), since the model never returned a plain answer.
    expect(result.message.content).not.toBe('I have processed your request.');
    expect(result.message.content).toContain('could not finish that reply');

    // `get_clinic_details` is a READ tool — it does not route through the
    // idempotent write ledger (`AiToolDispatchService.run()`, which is what
    // actually inserts into `ai_tool_calls`; confirmed by reading the
    // dispatcher: only booking/reschedule/cancel/handover writes call `run()`).
    // The dispositive count for "how many tool round-trips happened" is
    // therefore the provider's own captured requests, not the ledger table —
    // the in-memory `messages` array accumulates across iterations WITHIN one
    // turn (never re-fetched from the DB mid-turn), so the Nth captured
    // follow-up carries exactly N accumulated 'tool' role messages —
    // confirming every one of the MAX_TOOL_ITERATIONS-1 completed iterations
    // actually dispatched and fed back its tool call, no more, no fewer.
    for (let i = 1; i <= MAX_TOOL_ITERATIONS; i += 1) {
      const toolMsgs = harness.provider.capturedMessages(i).filter((m) => m.role === 'tool');
      expect(toolMsgs.length).toBe(i);
    }

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('mutually-recursive tool calls (A requests B, B requests A, forever) hit the SAME iteration ceiling — the cap is on loop iterations, not on distinct tool names or a cycle detector', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    harness.provider.script(
      Array.from({ length: 10 }, (_, i) => ({
        toolCalls: [scriptedToolCall(i % 2 === 0 ? 'get_clinic_details' : 'search_public_clinics', { hop: i })],
      })),
    );

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Trigger mutually-recursive tool calls.' },
      'REST',
    );

    expect(harness.provider.callCount).toBe(MAX_TOOL_ITERATIONS + WRAP_UP_CALLS);
    expect(result.message.content).not.toBe('I have processed your request.');
    expect(result.message.content).toContain('could not finish that reply');

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('[PROMOTED, RTP row 19, AI-023/T108-T111] the per-ITERATION tool-call fan-out is now bounded — a single scripted turn requesting 50 tool calls at once has only the first MAX_TOOL_CALLS_PER_ITERATION dispatched, the rest deterministically refused, none silently dropped', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    const FAN_OUT = 50;
    const CAP = 10; // AI_MAX_TOOL_CALLS_PER_ITERATION's default (env.validation.ts)
    harness.provider.script([
      {
        toolCalls: Array.from({ length: FAN_OUT }, (_, i) =>
          scriptedToolCall('get_clinic_details', { probe: `fanout-${i}` }),
        ),
      },
      { content: 'Final answer after the fan-out iteration.' },
    ]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Trigger a single massive tool-call fan-out.' },
      'REST',
    );

    // Still only 2 provider calls (the fan-out turn + the follow-up) —
    // MAX_TOOL_ITERATIONS (rounds) is unaffected; the NEW cap bounds
    // execution WITHIN one round, not how many rounds occur.
    expect(harness.provider.callCount).toBe(2);
    // [PROMOTED] all 50 still produce a tool-role message on the follow-up
    // call — FR-049 requires refused calls to be recorded, never silently
    // dropped from the transcript — but now only CAP of them carry a REAL
    // dispatched result; the rest carry the deterministic refusal.
    const toolMsgs = harness.provider.capturedMessages(1).filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(FAN_OUT);
    const refused = toolMsgs.filter((m) =>
      typeof m.content === 'string' && m.content.includes('Too many tool calls requested in one turn'),
    );
    const executed = toolMsgs.filter((m) => !refused.includes(m));
    expect(executed.length).toBe(CAP);
    expect(refused.length).toBe(FAN_OUT - CAP);

    // T111: the truncation is visible on the turn's own recorded outcome,
    // never a silent failure.
    const [metric] = await harness.dataSource.query(
      `SELECT tool_calls_truncated FROM ai_execution_metrics WHERE ai_conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [conv.id],
    );
    expect(metric.tool_calls_truncated).toBe(FAN_OUT - CAP);
    expect(result.message.content).toBe('Final answer after the fan-out iteration.');

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
