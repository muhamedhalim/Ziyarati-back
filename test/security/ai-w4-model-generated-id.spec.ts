/**
 * T055 — model-generated foreign-id injection (FR-021, FR-032, B5).
 *
 * The user never types tenant-B's identifiers anywhere in this file — they
 * exist ONLY inside the scripted provider's tool-call arguments, exactly as a
 * hallucinating or prompt-injected model might invent/emit them unprompted.
 * Drives a REAL turn via `AiExecutionService.sendMessage` so the full
 * dispatcher/ledger/response path executes, and asserts the refusal is
 * identical to a user-supplied attempt (T054) — proving enforcement lives at
 * the dispatcher/service boundary, never at "the model chose not to ask for
 * that", which the harness's `ScriptedAiProvider` structurally cannot do
 * (`scriptedToolCall()`'s own docblock: arguments are NOT sanitized, by
 * design — the audit measures the dispatcher, not the fixture).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

describe('AI-W4 model-generated foreign-id reproduction (T055)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let tenantContext: TenantContextService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    tenantContext = harness.app.get(TenantContextService);
  }, 120_000);

  /** A real, permission-bearing tenant-A staff principal (mirrors the gateway's own ctx.run/setPrincipal pattern). */
  function tenantAStaffPrincipal(): AuthenticatedUser {
    return {
      id: seed.tenantA.staffUserId,
      tenantId: seed.tenantA.id,
      roles: ['manager'],
      permissions: [
        PERMISSION.APPOINTMENTS_CREATE,
        PERMISSION.APPOINTMENTS_RESCHEDULE,
        PERMISSION.APPOINTMENTS_CANCEL,
        PERMISSION.APPOINTMENTS_READ,
        PERMISSION.CUSTOMERS_READ,
      ],
    };
  }

  function runAsTenantAStaff<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(() => {
      tenantContext.setPrincipal(tenantAStaffPrincipal());
      return fn();
    });
  }

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function tenantAConv(): Promise<AiConversation> {
    return conversations.start(seed.tenantA.id, {});
  }

  it('the model spontaneously emits tenant-B\'s customerId (never present in the user turn) — refused, no leak, ledger records the attempt', async () => {
    const conv = await tenantAConv();
    harness.provider.reset();
    // The user's message says NOTHING about a specific customer, id, or
    // tenant B — the id below exists only in the scripted tool call.
    const call = scriptedToolCall(AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS, {
      customerId: seed.tenantB.customerIds[0],
    });
    harness.provider.script([
      { toolCalls: [call] },
      { content: 'Final scripted answer after the tool call.' },
    ]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Do I have insurance on file?' },
      'REST',
    );
    expect(result.message.content).toContain('Final scripted answer');

    const followUp = harness.provider.capturedMessages(1);
    const toolMsg = followUp.find(
      (m) => m.role === 'tool' && (m as unknown as { tool_call_id?: string }).tool_call_id === call.id,
    );
    const parsed = JSON.parse(String(toolMsg!.content));
    expect(parsed.success).toBe(false);
    expect(parsed).not.toHaveProperty('hasInsurance');

    // Absent side effect: the ledger recorded a FAILED attempt, not a success.
    const ledger = await harness.dataSource.query(
      `SELECT status, tool_name FROM ai_tool_calls WHERE ai_conversation_id = $1 ORDER BY created_at ASC`,
      [conv.id],
    );
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0].tool_name).toBe(AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS);
    expect(ledger[0].status).not.toBe('SUCCEEDED');

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('the model spontaneously attempts to cancel tenant-B\'s appointment id — refused, appointment untouched', async () => {
    const conv = await tenantAConv();
    harness.provider.reset();
    const call = scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, {
      appointmentId: seed.tenantB.appointmentId,
      reason: 'model-invented cancellation',
    });
    harness.provider.script([
      { toolCalls: [call] },
      { content: 'Final scripted answer after the tool call.' },
    ]);

    const result = await runAsTenantAStaff(() =>
      execution.sendMessage(
        seed.tenantA.id,
        conv.id,
        { content: 'Please cancel my appointment.' },
        'REST',
      ),
    );
    expect(result.message.content).toContain('Final scripted answer');

    const followUp = harness.provider.capturedMessages(1);
    const toolMsg = followUp.find(
      (m) => m.role === 'tool' && (m as unknown as { tool_call_id?: string }).tool_call_id === call.id,
    );
    const parsed = JSON.parse(String(toolMsg!.content));
    expect(parsed.success).toBe(false);

    const status = await harness.dataSource.query(
      `SELECT status FROM appointments WHERE id = $1`,
      [seed.tenantB.appointmentId],
    );
    expect(status[0].status).not.toBe('CANCELLED');

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
