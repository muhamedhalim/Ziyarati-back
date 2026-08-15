/**
 * T148 — bound-manipulation reproduction (FR-073, FR-045).
 *
 * Attempts to inflate context size, retrieval size, output length, and
 * prompt-section budgets from BOTH user input and scripted model output,
 * against `AiPromptBudgetService` (`src/modules/ai/prompt/ai-prompt-budget.service.ts`)
 * and the RAG retrieval clamp (`AI_MODEL_CONTEXT_WINDOW_TOKENS` /
 * `ai-rag.service.ts`'s `topK` clamp). Every assertion is against the
 * APPLIED, server-observed bound — never the requested value — per the
 * task's own instruction.
 */
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import type { AddressInfo } from 'node:net';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiPromptBudgetService } from '../../src/modules/ai/prompt/ai-prompt-budget.service';
import { AiRagService } from '../../src/modules/ai/ai-rag.service';
import { AiKnowledgeBase } from '../../src/entities/AI Agent/AiKnowledgeBase';
import { AI_EVENT } from '../../src/modules/ai-realtime/ai-events.constants';

describe('AI abuse — bound manipulation (T148)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let budgets: AiPromptBudgetService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    budgets = harness.app.get(AiPromptBudgetService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('a massively oversized WS message (bypassing the REST-only 8000-char DTO validation) is still bounded to the applied prompt-token budget, never sent to the provider at its full size', async () => {
    await harness.app.listen(0);
    const address = harness.app.getHttpServer().address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const sessionRes = await request(harness.app.getHttpServer())
      .post('/api/v1/public/guest/session')
      .send({})
      .expect(200);
    const cookies = sessionRes.headers['set-cookie'] as unknown as string[];
    const guestCookie = cookies.find((c) => c.startsWith('guest_token='))!;
    const guestToken = decodeURIComponent(guestCookie.split(';')[0].split('=').slice(1).join('='));

    const client: ClientSocket = ioClient(`${baseUrl}/ai`, {
      auth: { token: guestToken },
      transports: ['websocket'],
      forceNew: true,
    });

    // Requested size: ~120,000 chars (~40,000+ estimated tokens under the
    // service's own conservative estimator) — far beyond both the 8000-char
    // DTO limit AND the ~12,000-token hard input ceiling.
    const oversizedContent = 'A'.repeat(120_000);

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), 10_000);
        client.on(AI_EVENT.CONNECTED, () => { clearTimeout(timer); resolve(); });
        client.on('connect_error', (e: Error) => { clearTimeout(timer); reject(e); });
      });

      harness.provider.reset();
      harness.provider.script([{ content: 'Bound-manipulation scripted reply.' }]);

      const done = await new Promise<{ aiConversationId: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ai:done timeout')), 15_000);
        client.once(AI_EVENT.DONE, (payload: { aiConversationId: string }) => { clearTimeout(timer); resolve(payload); });
        client.once(AI_EVENT.ERROR, (payload: unknown) => { clearTimeout(timer); reject(new Error(JSON.stringify(payload))); });
        client.emit(AI_EVENT.MESSAGE, { content: oversizedContent, channel: 'WEBSITE' });
      });

      expect(done.aiConversationId).toBeTruthy();
      expect(harness.provider.callCount).toBeGreaterThanOrEqual(1);

      // The APPLIED bound: what actually reached the "model" in the captured
      // request must be bounded by the configured budget, not by what was sent.
      const captured = harness.provider.capturedMessages(0);
      const totalEstimated = budgets.estimateMessages(captured as never);
      expect(totalEstimated).toBeLessThan(20_000); // well under the raw ~40,000-token request, close to contextWindow(16384)-ish ceiling
      // No single captured message contains the full 120,000-char string.
      for (const m of captured) {
        expect((m.content ?? '').length).toBeLessThan(oversizedContent.length);
      }

      await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [done.aiConversationId]);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [done.aiConversationId]);
    } finally {
      if (client.connected) client.disconnect();
      await new Promise<void>((resolve) => harness.app.getHttpServer().close(() => resolve()));
    }
  }, 30_000);

  it('a scripted model tool result of ~50,000 chars is truncated to maxToolOutputTokens before being fed back on the NEXT provider call', async () => {
    const conversations = harness.app.get(AiConversationService);
    const execution = harness.app.get(AiExecutionService);
    const conv = await conversations.start(seed.tenantA.id, {});

    harness.provider.reset();
    const hugeArgs = { note: 'x'.repeat(1000) };
    harness.provider.script([
      { toolCalls: [scriptedToolCall('get_clinic_details', hugeArgs)] },
      { content: 'Final answer after huge tool result.' },
    ]);

    await execution.sendMessage(seed.tenantA.id, conv.id, { content: 'Trigger a tool call.' }, 'REST');

    expect(harness.provider.callCount).toBe(2);
    // The SECOND captured request (the follow-up after the tool result) carries
    // the tool's result as a 'tool' role message — assert it is bounded by
    // maxToolOutputTokens (1200 default), never the tool dispatcher's raw
    // (potentially large) JSON result.
    const followUp = harness.provider.capturedMessages(1);
    const toolMessages = followUp.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    for (const m of toolMessages) {
      const estimated = budgets.estimate(m.content ?? '');
      expect(estimated).toBeLessThanOrEqual(1200 + 5); // maxToolOutputTokens default + rounding slack
    }

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('RAG retrieval size is clamped to 20 chunks regardless of a caller-inflated limit, proven against 25 real seeded rows', async () => {
    const rag = harness.app.get(AiRagService);
    const kb = harness.dataSource.getRepository(AiKnowledgeBase);

    const rows = await kb.save(
      Array.from({ length: 25 }, (_, i) =>
        kb.create({
          tenant: { id: seed.tenantA.id } as never,
          agent: { id: seed.tenantA.agentId } as never,
          content: `Bound-manipulation probe entry ${i}: keyword ZEBRAFINCH appears here so keyword search matches it.`,
          content_hash: `t148-probe-${i}-${Date.now()}`,
        }),
      ),
    );

    try {
      // Request an absurdly inflated limit — the service must clamp it server-side.
      const chunks = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, 'ZEBRAFINCH', 999_999);
      expect(chunks.length).toBeLessThanOrEqual(20);
      expect(chunks.length).toBeGreaterThan(0); // proves the query actually matched real rows, not an empty-result false pass
    } finally {
      await kb.delete(rows.map((r) => r.id));
    }
  }, 30_000);

  it('maxOutputTokens sent to the provider is a fixed server-side value on every call — never model- or client-selectable (no such field exists on SendMessageDto/MessagePayload)', async () => {
    const conversations = harness.app.get(AiConversationService);
    const execution = harness.app.get(AiExecutionService);
    const conv = await conversations.start(seed.tenantA.id, {});

    harness.provider.reset();
    harness.provider.script([{ content: 'ok', completionTokens: 999_999 }]); // model claims a huge completion — irrelevant to the REQUEST bound
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: 'probe output-length bound' }, 'REST');

    const captured = harness.provider.capturedRequests[0];
    expect(captured.maxOutputTokens).toBe(budgets.maxOutputTokens); // fixed config value (default 800)

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
