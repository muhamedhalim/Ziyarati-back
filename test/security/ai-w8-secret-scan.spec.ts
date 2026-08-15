/**
 * T120 — automated secret scan over captured context, tool results, emitted
 * logs, and error bodies (FR-036, FR-037, SC-006).
 *
 * Uses `secret-scan.ts`'s `scanText`/`scanValue` (structural, shape-based
 * patterns modeled on `env.validation.ts`'s credential-shaped keys — see that
 * file's header) against real output produced by driving real turns through
 * the harness: a representative REST turn, a WEBSOCKET-transport turn, a
 * WHATSAPP-transport turn, a guest (public-booking) turn, one real tool call,
 * one forced provider failure (REST error body), and every line written to
 * the console while all of the above ran.
 *
 * This spec is infrastructure-focused: it proves the scanner is live and
 * reports on the platform's OWN operational secrets (JWT/DB/OpenAI/webhook
 * keys — never a tenant-authored value) never appear anywhere ordinary
 * traffic reaches. The DECISIVE tenant-authored-canary cross-principal trace
 * lives in ai-w8-tenant-authored-secret.spec.ts (T121) — this file does not
 * duplicate it.
 */
import request from 'supertest';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scanText, scanValue, selfTest, SecretHit } from './fixtures/secret-scan';
import { scanCapturedRequest } from './fixtures/context-capture';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import {
  AiToolDispatchService,
  ToolContext,
} from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { WsAuthService } from '../../src/modules/ai-realtime/ws-auth.service';
import { GuestSessionService } from '../../src/modules/guest-chat/guest-session.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';

/** Captures every console write (Nest's ConsoleLogger routes through console.log/warn/error/debug) as plain text for scanning. Restores originals in `stop()`. */
function captureConsole() {
  const lines: string[] = [];
  const methods: Array<'log' | 'warn' | 'error' | 'debug' | 'info'> = [
    'log',
    'warn',
    'error',
    'debug',
    'info',
  ];
  const originals = methods.map((m) => console[m]);
  methods.forEach((m) => {
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  });
  return {
    text: () => lines.join('\n'),
    stop: () => methods.forEach((m, i) => (console[m] = originals[i])),
  };
}

function reportHits(sink: string, hits: (SecretHit & { path?: string; messageIndex?: number })[]) {
  if (hits.length === 0) return;
  // Never printed as a plain fail message with the raw text — pattern name + location only.
  process.stdout.write(
    `\n===SECRET-SCAN-HIT sink=${sink} count=${hits.length} patterns=${JSON.stringify(hits.map((h) => h.pattern))}===\n`,
  );
}

describe('W8 — automated secret scan over real captured sinks (T120)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let execution: AiExecutionService;
  let conversations: AiConversationService;
  let dispatch: AiToolDispatchService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    execution = harness.app.get(AiExecutionService);
    conversations = harness.app.get(AiConversationService);
    dispatch = harness.app.get(AiToolDispatchService);

    await harness.dataSource.query(
      `INSERT INTO tenant_settings (tenant_id, public_booking_enabled) VALUES ($1, true)
       ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true`,
      [seed.tenantA.id],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('sanity: the scanner itself detects a planted synthetic canary and reports zero hits on clean clinical text (selfTest)', () => {
    const result = selfTest();
    expect(result.plantedDetected).toBe(true);
    expect(result.cleanTextIsClean).toBe(true);
  });

  it('REST turn: captured provider request + persisted messages carry no platform-secret-shaped values', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    harness.provider.script([{ content: 'Our clinic is open 9am-5pm, Monday to Friday.' }]);

    const console_ = captureConsole();
    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'What are your opening hours?' },
      'REST',
    );
    console_.stop();

    const requestHits = scanCapturedRequest(harness.provider.capturedRequests[0]);
    const logHits = scanText(console_.text());
    reportHits('rest.provider-request', requestHits);
    reportHits('rest.logs', logHits);
    expect(requestHits).toEqual([]);
    expect(logHits).toEqual([]);
    expect(result.message.content).toContain('open 9am-5pm');

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('WEBSOCKET-transport turn: captured provider request carries no secret-shaped values', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    harness.provider.script([{ content: 'Streamed reply, no secrets here.' }]);

    let streamed = '';
    await execution.streamMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Do you accept walk-ins?' },
      (delta) => (streamed += delta),
      undefined,
      'WEBSOCKET',
    );

    const requestHits = scanCapturedRequest(harness.provider.capturedRequests[0]);
    reportHits('websocket.provider-request', requestHits);
    expect(requestHits).toEqual([]);
    expect(streamed).toContain('Streamed reply');

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('WHATSAPP-transport turn: captured provider request carries no secret-shaped values', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    harness.provider.script([{ content: 'WhatsApp reply, no secrets here.' }]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Can I book for tomorrow?' },
      'WHATSAPP',
    );

    const requestHits = scanCapturedRequest(harness.provider.capturedRequests[0]);
    reportHits('whatsapp.provider-request', requestHits);
    expect(requestHits).toEqual([]);
    expect(result.message.content).toContain('WhatsApp reply');

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('GUEST turn (public discovery/booking channel): captured provider request carries no secret-shaped values', async () => {
    const wsAuth = harness.app.get(WsAuthService);
    const sessions = harness.app.get(ConversationSessionService);
    const guestRes = await request(harness.app.getHttpServer())
      .post('/api/v1/public/guest/session')
      .send({})
      .expect(200);
    const cookies = guestRes.headers['set-cookie'] as unknown as string[];
    const guestCookie = cookies.find((c) => c.startsWith('guest_token='))!;
    const guestPrincipal = await wsAuth.authenticate({
      handshake: { auth: {}, headers: { cookie: guestCookie.split(';')[0] }, query: {} },
    } as never);
    const discoveryTenantId = await harness.app.get(GuestSessionService).ensureDiscoveryTenant();

    const conv = await conversations.start(discoveryTenantId, {});
    await sessions.patch(discoveryTenantId, conv.id, { guestSubject: guestPrincipal.id });

    harness.provider.reset();
    harness.provider.script([{ content: 'You can find clinics by city — which city are you in?' }]);

    const ctx = harness.app.get(TenantContextService);
    const result = await ctx.run(async () => {
      ctx.setPrincipal(guestPrincipal);
      return execution.sendMessage(discoveryTenantId, conv.id, { content: 'I want to find a clinic.' }, 'REST');
    });

    const requestHits = scanCapturedRequest(harness.provider.capturedRequests[0]);
    reportHits('guest.provider-request', requestHits);
    expect(requestHits).toEqual([]);
    expect(result.message.content).toContain('which city');

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('one real tool call result carries no secret-shaped values', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const toolCtx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id };
    const toolResult = await dispatch.execute(toolCtx, {
      id: 'tc-1',
      name: AI_TOOL.SEARCH_CLINICS,
      arguments: JSON.stringify({ query: 'dental' }),
    });

    const hits = scanValue(toolResult);
    reportHits('tool-result.search_clinics', hits);
    expect(hits).toEqual([]);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('forced provider failure: the REST client-visible error body carries no secret-shaped values', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    harness.provider.reset();
    harness.provider.scriptFailure({ kind: '5xx', status: 503 });

    const res = await request(harness.app.getHttpServer())
      .post('/api/v1/ai/orchestrator/message')
      .set(
        'Authorization',
        `Bearer ${await harness.jwt.signAsync(
          { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
          { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
        )}`,
      )
      .send({ channel: 'DASHBOARD', content: 'trigger a failure', aiConversationId: conv.id });

    const hits = scanValue(res.body);
    reportHits('rest.error-body', hits);
    expect(hits).toEqual([]);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
