/**
 * T053 — direct-query cross-tenant reproduction (FR-018, FR-021).
 *
 * A tenant-A principal asks the assistant, in plain chat text, for tenant-B
 * data by identifier and by a name-bearing sentence. Drives a REAL turn via
 * `AiExecutionService.sendMessage` (never `AiOrchestratorService.handle`, per
 * `HARNESS_GUIDE.md` gotcha 8), scripting the provider so the "model" attempts
 * exactly what the user asked. Asserts the tool result fed back to the model
 * (the repository-level result surfaced through the dispatcher) and the
 * database itself both contain zero tenant-B rows — never the wording of the
 * scripted final reply, which this harness fully controls and is therefore
 * not evidence (FR-006).
 *
 * Target tool: `get_customer_insurance_status` — the one core tool that (a)
 * accepts a bare model-supplied resource id, (b) is NOT permission-gated
 * (`w3-declared-vs-enforced.md` row 5), and (c) is reachable with a
 * zero-permission `ToolContext` exactly like an ordinary authenticated
 * customer-facing turn.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { CustomerService } from '../../src/modules/crm/customer.service';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

describe('AI-W4 direct-query cross-tenant reproduction (T053)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let customers: CustomerService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    customers = harness.app.get(CustomerService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function startTenantAConversation(): Promise<AiConversation> {
    return conversations.start(seed.tenantA.id, {});
  }

  /** Pulls the `role: 'tool'` message the dispatcher fed back for a given call id. */
  function toolResultMessage(callIndex: number, toolCallId: string) {
    const msgs = harness.provider.capturedMessages(callIndex);
    return msgs.find(
      (m) => m.role === 'tool' && (m as unknown as { tool_call_id?: string }).tool_call_id === toolCallId,
    );
  }

  it('control: the tenant-A principal CAN read their own customer (proves the fixture is not fail-closed by accident)', async () => {
    const foreignCustomer = await customers.findOneOrThrow(seed.tenantA.id, seed.tenantA.customerIds[0]);
    expect(foreignCustomer.id).toBe(seed.tenantA.customerIds[0]);
  });

  it('refuses a direct request for tenant-B customer data BY IDENTIFIER — zero rows in the tool result and the database', async () => {
    const conv = await startTenantAConversation();
    harness.provider.reset();
    const call = scriptedToolCall('get_customer_insurance_status', {
      customerId: seed.tenantB.customerIds[0],
    });
    harness.provider.script([
      { toolCalls: [call] },
      { content: 'Final scripted answer after the tool call.' },
    ]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: `What is the insurance status for customer ${seed.tenantB.customerIds[0]}?` },
      'REST',
    );
    expect(result.message.content).toContain('Final scripted answer');

    // Repository-level result set: the tool message fed back to the "model".
    const toolMsg = toolResultMessage(1, call.id);
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(String(toolMsg!.content));
    expect(parsed.success).toBe(false);
    expect(parsed).not.toHaveProperty('hasInsurance');
    expect(parsed).not.toHaveProperty('known');

    // Independent repository-level assertion — the same lookup the tool used.
    await expect(
      customers.findOneOrThrow(seed.tenantA.id, seed.tenantB.customerIds[0]),
    ).rejects.toMatchObject({ statusCode: 404 });

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('refuses a direct request for tenant-B customer data phrased BY NAME in chat text (the id is still what reaches the tool)', async () => {
    const conv = await startTenantAConversation();
    harness.provider.reset();
    const foreignCustomer = await customers.findOneOrThrow(seed.tenantB.id, seed.tenantB.customerIds[1]);
    const call = scriptedToolCall('get_customer_insurance_status', {
      customerId: seed.tenantB.customerIds[1],
    });
    harness.provider.script([
      { toolCalls: [call] },
      { content: 'Final scripted answer after the tool call.' },
    ]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: `Does ${foreignCustomer.full_name} have health insurance on file?` },
      'REST',
    );
    expect(result.message.content).toContain('Final scripted answer');

    const toolMsg = toolResultMessage(1, call.id);
    const parsed = JSON.parse(String(toolMsg!.content));
    expect(parsed.success).toBe(false);
    expect(parsed).not.toHaveProperty('hasInsurance');
    expect(JSON.stringify(parsed)).not.toContain(foreignCustomer.full_name);

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
