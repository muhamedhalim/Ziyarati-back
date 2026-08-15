/**
 * T139 — partial-effect-on-failed-turn reproduction (FR-078).
 *
 * A tool call can commit a REAL business effect (e.g. cancel an appointment)
 * and then the SAME turn's tool-result follow-up call to the provider can
 * fail (timeout / 5xx / network error). `AiExecutionService.sendMessage`'s
 * tool loop is NOT wrapped in a database transaction spanning the whole turn
 * (by design, per the class docblock: "not wrapped in a DB transaction — a
 * connection must not be held across network + booking calls") — only each
 * tool's OWN executor runs inside its own short transaction/ledger write.
 *
 * This spec proves, against the real database:
 *  1. the tool's business effect (appointment cancelled) is COMMITTED and
 *     durable even though the surrounding turn subsequently throws;
 *  2. the turn-level ledger (`ai_request_executions`) records the failure as
 *     `UNKNOWN_OUTCOME` — the honest state name, since the caller cannot
 *     safely assume nothing happened — while the tool-level ledger
 *     (`ai_tool_calls`) independently and correctly shows `SUCCEEDED`;
 *  3. no assistant message is persisted for the failed turn, and nothing in
 *     this code path creates a reconciliation record cross-referencing the
 *     two ledgers — an operator (or the customer) has no automated signal
 *     that "the cancellation actually went through despite the error".
 *
 * Deliberately sequential (`it` blocks, not `test.concurrent`) and does not
 * run alongside another file's appointment-mutating tests, per the task's
 * own instruction — this file's tenant/appointment state must not race
 * another suite's.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { AppointmentStatus } from '../../src/entities/enums';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';

describe('AI partial-effect-on-failed-turn (T139)', () => {
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

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  const staffPrincipal = (): AuthenticatedUser => ({
    id: seed.tenantA.staffUserId,
    tenantId: seed.tenantA.id,
    roles: [],
    permissions: [PERMISSION.APPOINTMENTS_CANCEL],
  });

  /** Mirrors `AiRealtimeGateway.onMessage`'s pattern for restoring a principal outside an HTTP request. */
  function asPrincipal<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(() => {
      tenantContext.setPrincipal(staffPrincipal());
      return fn();
    });
  }

  it('appointment cancellation (tool effect) is a real, committed, durable side effect', async () => {
    const before = await harness.dataSource.query(
      `SELECT status FROM appointments WHERE id = $1`,
      [seed.tenantA.appointmentId],
    );
    expect(before[0].status).toBe(AppointmentStatus.CONFIRMED);

    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    // Turn: model cancels the appointment, THEN — after the tool result is
    // fed back — the follow-up provider call TIMES OUT (mid-stream-disconnect
    // equivalent: the tool already ran; only the post-tool completion fails).
    harness.provider.script([
      {
        toolCalls: [
          scriptedToolCall('cancel_appointment', {
            appointmentId: seed.tenantA.appointmentId,
            reason: 'W9 partial-effect repro (T139)',
          }),
        ],
      },
      { throw: { kind: 'timeout' } },
    ]);

    const idempotencyKey = `t139-partial-effect-${conv.id}`;
    await expect(
      asPrincipal(() =>
        execution.sendMessage(
          seed.tenantA.id,
          conv.id,
          { content: 'Please cancel my appointment.', idempotencyKey },
          'REST',
        ),
      ),
    ).rejects.toBeDefined();

    // 1) The business effect is REAL and COMMITTED — not rolled back by the
    //    later provider failure, because the tool's own transaction already
    //    committed independently of the turn-level try/catch.
    const after = await harness.dataSource.query(
      `SELECT status FROM appointments WHERE id = $1`,
      [seed.tenantA.appointmentId],
    );
    expect(after[0].status).toBe(AppointmentStatus.CANCELLED);

    // 2) The tool-level ledger independently shows SUCCEEDED with the
    //    appointment id attached — fully inspectable in isolation.
    const [toolCallRow] = await harness.dataSource.query(
      `SELECT status, appointment_id, result FROM ai_tool_calls
        WHERE tenant_id = $1 AND ai_conversation_id = $2 AND tool_name = 'cancel_appointment'`,
      [seed.tenantA.id, conv.id],
    );
    expect(toolCallRow.status).toBe('SUCCEEDED');
    expect(toolCallRow.appointment_id).toBe(seed.tenantA.appointmentId);

    // 3) The TURN-level ledger records the honest "we don't know if the
    //    caller learned the outcome" state — UNKNOWN_OUTCOME, per
    //    `ai-execution.service.ts`'s catch block (`providerStarted` was true,
    //    so `fail()` is called with 'UNKNOWN_OUTCOME' / 'PROVIDER_OR_POST_PROVIDER_FAILURE').
    const [requestRow] = await harness.dataSource.query(
      `SELECT state, error_code FROM ai_request_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [seed.tenantA.id, idempotencyKey],
    );
    expect(requestRow.state).toBe('UNKNOWN_OUTCOME');
    expect(requestRow.error_code).toBe('PROVIDER_OR_POST_PROVIDER_FAILURE');

    // 4) No assistant message was persisted for this failed turn (the model's
    //    final "sorry, something went wrong" text — if any — never made it
    //    to the transcript, because the throw happened before the
    //    persist-assistant-message transaction).
    const assistantMessages = await harness.dataSource.query(
      `SELECT id FROM ai_messages WHERE ai_conversation_id = $1 AND role = 'assistant'`,
      [conv.id],
    );
    expect(assistantMessages).toHaveLength(0);

    // 5) No reconciliation record cross-references the two ledgers. There is
    //    no column on `ai_request_executions` pointing at the `ai_tool_calls`
    //    row it left behind, and no separate reconciliation table exists for
    //    this case (unlike the batch subsystem's `SUBMISSION_UNKNOWN` +
    //    `reconcileSubmissions()`, or the write-tool idempotency ledger's own
    //    replay-on-retry — this turn-level UNKNOWN_OUTCOME has no analogous
    //    automated follow-up). A human must independently know to cross-check
    //    `ai_tool_calls` for a given `ai_request_executions` row by
    //    (tenant, ai_conversation_id, approximate timestamp) — there is no
    //    direct foreign key or shared correlation id between the two tables.
    const columns = await harness.dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_request_executions'`,
    );
    const columnNames: string[] = columns.map((c: { column_name: string }) => c.column_name);
    expect(columnNames).not.toContain('tool_call_id');
    expect(columnNames).not.toContain('reconciliation_ref');

    process.stdout.write('\n===PARTIAL-EFFECT-T139===\n');
    process.stdout.write(
      JSON.stringify(
        {
          appointmentStatusBefore: before[0].status,
          appointmentStatusAfter: after[0].status,
          toolCallLedger: { status: toolCallRow.status, appointmentId: toolCallRow.appointment_id },
          turnLedger: { state: requestRow.state, errorCode: requestRow.error_code },
          assistantMessagesPersisted: assistantMessages.length,
          requestExecutionsColumns: columnNames,
        },
        null,
        2,
      ) + '\n',
    );
  }, 30_000);

  it('a retry with the SAME idempotency key after an UNKNOWN_OUTCOME is refused, not silently replayed or re-executed', async () => {
    // From the previous test: idempotency key t139-partial-effect-<conv> is
    // now in state UNKNOWN_OUTCOME on tenantA. AiRequestExecutionService.claim()
    // treats UNKNOWN_OUTCOME as terminal-but-unsafe: neither COMPLETED (replay)
    // nor eligible for a fresh STARTED claim (unlike FAILED_RETRYABLE, which
    // IS reopened). This is the correct conservative choice — verify it holds.
    const conv2 = await conversations.start(seed.tenantA.id, {});
    // Reuse a FRESH conversation but manually pre-seed an UNKNOWN_OUTCOME row
    // to isolate this assertion from the previous test's exact key (avoids
    // cross-test coupling on execution order for this one check).
    const key = `t139-preexisting-unknown-${conv2.id}`;
    await harness.dataSource.query(
      `INSERT INTO ai_request_executions (tenant_id, idempotency_key, feature, channel, state, error_code)
       VALUES ($1, $2, 'chat', 'REST', 'UNKNOWN_OUTCOME', 'PROVIDER_OR_POST_PROVIDER_FAILURE')`,
      [seed.tenantA.id, key],
    );

    harness.provider.reset();
    harness.provider.script([{ content: 'This should never be reached.' }]);

    await expect(
      asPrincipal(() =>
        execution.sendMessage(
          seed.tenantA.id,
          conv2.id,
          { content: 'Retry.', idempotencyKey: key },
          'REST',
        ),
      ),
    ).rejects.toBeDefined();

    // The provider was never called again — the claim was refused before any
    // provider round-trip, consistent with "requires manual verification"
    // rather than an automatic retry that could double-execute a tool.
    expect(harness.provider.callCount).toBe(0);
  }, 30_000);
});
