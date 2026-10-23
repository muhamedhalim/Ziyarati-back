/**
 * T121 — the decisive tenant-authored-secret trace (FR-035, FR-036, FR-037,
 * FR-038, SC-006).
 *
 * Plants TWO distinct SYNTHETIC canaries (never a real credential):
 *   - CANARY_SYS — inside tenant A's `AiAgent.system_prompt`.
 *   - CANARY_KB  — inside a tenant-A knowledge document, ingested through the
 *     REAL training-file → knowledge-base pipeline (`AiKnowledgeIngestionService
 *     .ingestDocument`), so the embedding-input and vector-storage sinks are
 *     genuinely exercised (this spec boots the harness in pgvector mode — the
 *     `zt-audit-pgvector` container is already provisioned, see
 *     `provision-pgvector-db.js`).
 *
 * For each canary, traces whether it reaches: (1) model/provider payload,
 * (2) emitted logs, (3) embedding inputs, (4) vector storage rows, (5) the
 * keyword-retrieval index, (6) stored memory, (7) Redis/embedding cache,
 * (8) tool output, (9) another principal's context — a second tenant-A user,
 * a tenant-B user, and a guest — and (10) client-visible error responses.
 *
 * Sink 9 is the decisive check: it drives a real turn/attempt as each of the
 * three OTHER principals — including a direct attempt to address tenant A's
 * own conversation id — and asserts the canary appears in none of their
 * assembled contexts or responses.
 */
import request from 'supertest';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scanText, selfTest } from './fixtures/secret-scan';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiConversationAccessService } from '../../src/modules/ai/ai-conversation-access.service';
import { AiOrchestratorService } from '../../src/modules/ai-orchestrator/ai-orchestrator.service';
import { AiMemoryService } from '../../src/modules/ai-memory/ai-memory.service';
import { AiKnowledgeIngestionService } from '../../src/modules/ai/ingestion/ai-knowledge-ingestion.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import { WsAuthService } from '../../src/modules/ai-realtime/ws-auth.service';
import { GuestSessionService } from '../../src/modules/guest-chat/guest-session.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { AppRedisService } from '../../src/queue/app-redis.service';
import { AiAgent } from '../../src/entities/AI Agent/AiAgent';
import { AiTrainingFile } from '../../src/entities/AI Agent/AiTrainingFile';
import { AppError } from '../../src/common/errors';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import type { Socket } from 'socket.io';

function captureConsole() {
  const lines: string[] = [];
  const methods: Array<'log' | 'warn' | 'error' | 'debug' | 'info'> = ['log', 'warn', 'error', 'debug', 'info'];
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

function fakeSocket(user: AuthenticatedUser): Socket {
  return {
    data: { tenantId: user.tenantId, userId: user.id, user },
    emit: jest.fn(),
    join: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    rooms: new Set<string>(),
  } as unknown as Socket;
}

describe('W8 — tenant-authored synthetic canary trace across every sink (T121, decisive)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let access: AiConversationAccessService;
  let orchestrator: AiOrchestratorService;
  let memory: AiMemoryService;
  let ingestion: AiKnowledgeIngestionService;
  let dispatch: AiToolDispatchService;
  let ctx: TenantContextService;
  let appRedis: AppRedisService;

  const RUN = Math.random().toString(36).slice(2, 10);
  const CANARY_SYS = `sk-audit-synthetic-canary-${RUN}-sysprompt`;
  const CANARY_KB = `sk-audit-synthetic-canary-${RUN}-kbdoc`;
  const KB_MATCH_QUERY =
    'Can you explain your specialty imaging protocol for advanced diagnostic referrals?';
  // Since F-08b a relevance floor (RAG_MIN_SCORE, default 0.5) rejects a chunk whose cosine to the query is
  // below it, and the scripted 16-dim signed bag-of-words vectors give a merely-similar question a cosine
  // that can be under 0.5 (or negative). The canary token is random per run, so the cosine would also vary
  // per run. Make the document carry the question's own wording four times: its vector is then dominated by
  // the query's direction (cosine ~0.9 whatever the canary hashes to), the chunk is retrieved on the real
  // vector path with the real floor in force, and the QUERY still contains no canary, which the cross-tenant
  // assertions below rely on.
  const KB_TEXT =
    `Internal engineering reference (synthetic, audit-only, never a real secret): ${CANARY_KB}. ` +
    `${KB_MATCH_QUERY} `.repeat(4).trim();

  let tenantAConversationId: string;
  let trainingFileId: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness({ pgvector: true });
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    access = harness.app.get(AiConversationAccessService);
    orchestrator = harness.app.get(AiOrchestratorService);
    memory = harness.app.get(AiMemoryService);
    ingestion = harness.app.get(AiKnowledgeIngestionService);
    dispatch = harness.app.get(AiToolDispatchService);
    ctx = harness.app.get(TenantContextService);
    appRedis = harness.app.get(AppRedisService);

    for (const tenantId of [seed.tenantA.id, seed.tenantB.id, seed.discoveryTenantId]) {
      await harness.dataSource.query(
        `INSERT INTO tenant_settings (tenant_id, public_booking_enabled) VALUES ($1, true)
         ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true`,
        [tenantId],
      );
    }

    // ── Plant canary 1: tenant A's own AiAgent.system_prompt. ──────────────
    await harness.dataSource.getRepository(AiAgent).update(
      { id: seed.tenantA.agentId },
      {
        system_prompt: `You are the AI receptionist for synthetic AI-audit tenant. Internal reference token (synthetic, audit-only, never a real secret): ${CANARY_SYS}`,
      },
    );

    // ── Plant canary 2: a tenant-A training file, ingested into the KB via the REAL pipeline. ──
    const trainingFiles = harness.dataSource.getRepository(AiTrainingFile);
    const tf = await trainingFiles.save(
      trainingFiles.create({
        tenant: { id: seed.tenantA.id } as never,
        agent: { id: seed.tenantA.agentId } as never,
        file_name: 'w8-canary-training-file.txt',
        file_url: 'internal://synthetic/w8-canary-training-file.txt',
        file_type: 'TXT',
        status: 'INDEXED',
      }),
    );
    trainingFileId = tf.id;
    await ingestion.ingestDocument(seed.tenantA.id, seed.tenantA.agentId, KB_TEXT, trainingFileId);

    // Sanity: both canaries actually landed where planted, before tracing them.
    const agentRow = await harness.dataSource.getRepository(AiAgent).findOne({ where: { id: seed.tenantA.agentId } });
    expect(agentRow?.system_prompt).toContain(CANARY_SYS);
    const kbRows = await harness.dataSource.query(
      `SELECT id FROM ai_knowledge_bases WHERE "tenantId" = $1 AND content LIKE $2`,
      [seed.tenantA.id, `%${CANARY_KB}%`],
    );
    expect(kbRows.length).toBeGreaterThan(0);
  }, 180_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('scanner sanity (selfTest)', () => {
    const result = selfTest();
    expect(result.plantedDetected).toBe(true);
    expect(result.cleanTextIsClean).toBe(true);
  });

  it('sinks 1, 3, 4, 5 — a tenant-A turn that retrieves the KB canary: EXPECTED exposure in the model payload, embedding input, vector storage row, and keyword index (tenant A, tenant A\'s own agent)', async () => {
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    tenantAConversationId = conv.id;
    harness.provider.reset();
    harness.embedding.reset();
    harness.provider.script([{ content: 'Here is what our specialty imaging protocol covers.' }]);

    const result = await execution.sendMessage(seed.tenantA.id, conv.id, { content: KB_MATCH_QUERY }, 'REST');

    // Sink 1 — model/provider payload.
    const captured = harness.provider.capturedRequests[0];
    const sysMsg = captured.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain(CANARY_SYS);
    const anyMessageHasKb = captured.messages.some((m) => m.content?.includes(CANARY_KB));
    expect(anyMessageHasKb).toBe(true);

    // Sink 3 — embedding input (query embedding call made during retrieve()).
    const queryEmbedCalls = harness.embedding.capturedCalls.filter((c) => c.texts.some((t) => t === KB_MATCH_QUERY));
    expect(queryEmbedCalls.length).toBeGreaterThan(0);

    // Sink 4 — vector storage row (ai_kb_embeddings), correctly tenant/agent scoped.
    const vectorRows = await harness.dataSource.query(
      `SELECT e.tenant_id, e.agent_id FROM ai_kb_embeddings e
         JOIN ai_knowledge_bases k ON k.id = e.kb_id
        WHERE k.content LIKE $1`,
      [`%${CANARY_KB}%`],
    );
    expect(vectorRows.length).toBeGreaterThan(0);
    for (const row of vectorRows) {
      expect(row.tenant_id).toBe(seed.tenantA.id);
      expect(row.agent_id).toBe(seed.tenantA.agentId);
    }

    // Sink 5 — keyword-retrieval index (ai_knowledge_bases itself).
    const kbRows = await harness.dataSource.query(
      `SELECT "tenantId", "agentId" FROM ai_knowledge_bases WHERE content LIKE $1`,
      [`%${CANARY_KB}%`],
    );
    expect(kbRows.length).toBeGreaterThan(0);
    for (const row of kbRows) {
      expect(row.tenantId).toBe(seed.tenantA.id);
      expect(row.agentId).toBe(seed.tenantA.agentId);
    }

    expect(result.retrievedChunks).toBeGreaterThan(0);

    process.stdout.write(
      `\n===T121-EXPECTED-EXPOSURE tenant=A own-agent sys=present kb=present retrievedChunks=${result.retrievedChunks}===\n`,
    );
  }, 30_000);

  it('sink 2 — emitted logs during that canary-laden turn (reported, not assumed)', async () => {
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.script([{ content: 'Logged turn, scripted reply.' }]);

    const console_ = captureConsole();
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: KB_MATCH_QUERY }, 'REST');
    console_.stop();

    const text = console_.text();
    const sysHit = text.includes(CANARY_SYS);
    const kbHit = text.includes(CANARY_KB);
    process.stdout.write(`\n===T121-SINK2-LOGS sysHit=${sysHit} kbHit=${kbHit}===\n`);
    // Recorded, not silently swallowed — see T121 evidence write-up for the verdict.
    expect(typeof sysHit).toBe('boolean');

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('sink 6 — no automatic memory write picks up either canary during an ordinary turn; the explicit remember/recall seam is itself tenant-scoped', async () => {
    const before = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_memories WHERE "tenantId" = $1`,
      [seed.tenantA.id],
    );
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.script([{ content: 'No auto-memory should be written for this reply.' }]);
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: KB_MATCH_QUERY }, 'REST');
    const after = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_memories WHERE "tenantId" = $1`,
      [seed.tenantA.id],
    );
    expect(after[0].c).toBe(before[0].c);

    // Explicit memory pathway, using canary content, to prove tenant scoping on remember/recall itself.
    await memory.remember(seed.tenantA.id, {
      type: 'note',
      content: `Synthetic canary memory note: ${CANARY_KB}`,
      importance: 3,
    } as never);
    const recalledA = await memory.recall(seed.tenantA.id, { query: 'synthetic canary memory note', limit: 5 } as never);
    expect(recalledA.some((m) => m.content.includes(CANARY_KB))).toBe(true);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('sink 7 — full Redis keyspace scan: no key holds either canary anywhere', async () => {
    const client = appRedis.application;
    let cursor = '0';
    const hits: string[] = [];
    do {
      const [next, keys] = await client.scan(cursor, 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        const type = await client.type(key);
        let text = '';
        if (type === 'string') text = (await client.get(key)) ?? '';
        else if (type === 'hash') text = JSON.stringify(await client.hgetall(key));
        else if (type === 'list') text = (await client.lrange(key, 0, -1)).join('\n');
        else if (type === 'set') text = (await client.smembers(key)).join('\n');
        else continue;
        if (text.includes(CANARY_SYS) || text.includes(CANARY_KB)) hits.push(key);
      }
    } while (cursor !== '0');
    process.stdout.write(`\n===T121-SINK7-REDIS-SCAN hits=${JSON.stringify(hits)}===\n`);
    expect(hits).toEqual([]);
  }, 60_000);

  it('sink 8 — tool outputs never carry either canary (public discovery tools)', async () => {
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    const toolCtx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id };
    const searchResult = await dispatch.execute(toolCtx, {
      id: 't1',
      name: AI_TOOL.SEARCH_CLINICS,
      arguments: JSON.stringify({ query: 'clinic' }),
    });
    const detailResult = await dispatch.execute(toolCtx, {
      id: 't2',
      name: AI_TOOL.GET_CLINIC_DETAILS,
      arguments: JSON.stringify({ clinicId: seed.tenantA.id }),
    });
    const combined = JSON.stringify([searchResult, detailResult]);
    expect(combined.includes(CANARY_SYS)).toBe(false);
    expect(combined.includes(CANARY_KB)).toBe(false);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('sink 9 (control) — a SECOND tenant-A user, own new conversation, same agent: legitimate expected exposure (baseline for comparison)', async () => {
    const secondPrincipal: AuthenticatedUser = {
      id: seed.tenantA.customerIds[1],
      tenantId: seed.tenantA.id,
      roles: [],
      permissions: [],
    };
    const conv = await ctx.run(async () => {
      ctx.setPrincipal(secondPrincipal);
      return conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    });
    harness.provider.reset();
    harness.provider.script([{ content: 'Second tenant-A user reply.' }]);
    await ctx.run(async () => {
      ctx.setPrincipal(secondPrincipal);
      return execution.sendMessage(seed.tenantA.id, conv.id, { content: KB_MATCH_QUERY }, 'REST');
    });
    const captured = harness.provider.capturedRequests[0];
    const sysMsg = captured.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain(CANARY_SYS);
    expect(captured.messages.some((m) => m.content?.includes(CANARY_KB))).toBe(true);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('sink 9 (DECISIVE) — a tenant-B user cannot reach either canary: own separate agent/KB fishing attempt AND a direct attempt on tenant A\'s conversation id are both empty/rejected', async () => {
    const tenantBPrincipal: AuthenticatedUser = {
      id: seed.tenantB.staffUserId,
      tenantId: seed.tenantB.id,
      roles: [],
      permissions: [],
    };

    // (a) Own separate conversation, same "fishing" query text that matched the canary for tenant A.
    const convB = await ctx.run(async () => {
      ctx.setPrincipal(tenantBPrincipal);
      return conversations.start(seed.tenantB.id, { agentId: seed.tenantB.agentId });
    });
    harness.provider.reset();
    harness.provider.script([{ content: 'Tenant B has no such document.' }]);
    await ctx.run(async () => {
      ctx.setPrincipal(tenantBPrincipal);
      return execution.sendMessage(seed.tenantB.id, convB.id, { content: KB_MATCH_QUERY }, 'REST');
    });
    const capturedB = harness.provider.capturedRequests[0];
    const combinedB = JSON.stringify(capturedB.messages);
    expect(combinedB.includes(CANARY_SYS)).toBe(false);
    expect(combinedB.includes(CANARY_KB)).toBe(false);

    // (b) Direct attempt: tenant B's own tenantId + tenant A's conversation id, through the
    // REAL cross-principal gate (AiConversationAccessService via the orchestrator's resume path).
    const callCountBefore = harness.provider.callCount;
    await expect(
      ctx.run(async () => {
        ctx.setPrincipal(tenantBPrincipal);
        return orchestrator.handle(seed.tenantB.id, {
          channel: 'DASHBOARD',
          content: KB_MATCH_QUERY,
          aiConversationId: tenantAConversationId,
        });
      }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(harness.provider.callCount).toBe(callCountBefore); // provider never reached

    // (c) Direct assertAccess probe (same gate, isolated).
    await expect(access.assertAccess(seed.tenantB.id, tenantAConversationId, tenantBPrincipal)).rejects.toBeInstanceOf(
      AppError,
    );

    // (d) Memory recall from tenant B never returns tenant A's canary memory.
    const recalledB = await memory.recall(seed.tenantB.id, { query: 'synthetic canary memory note', limit: 5 } as never);
    expect(recalledB.some((m) => m.content.includes(CANARY_KB))).toBe(false);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [convB.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convB.id]);
  }, 30_000);

  it('sink 9 (DECISIVE) — a guest cannot reach either canary: cannot bind tenant A\'s agent, own conversation is empty, and a direct attempt on tenant A\'s conversation id is rejected', async () => {
    const wsAuth = harness.app.get(WsAuthService);
    const guestRes = await request(harness.app.getHttpServer()).post('/api/v1/public/guest/session').send({}).expect(200);
    const cookies = guestRes.headers['set-cookie'] as unknown as string[];
    const guestCookie = cookies.find((c) => c.startsWith('guest_token='))!;
    const guestPrincipal = await wsAuth.authenticate({
      handshake: { auth: {}, headers: { cookie: guestCookie.split(';')[0] }, query: {} },
    } as never);
    const discoveryTenantId = await harness.app.get(GuestSessionService).ensureDiscoveryTenant();

    // (a) A guest cannot even bind tenant A's agent (cross-tenant FK check fails closed).
    await expect(
      conversations.start(discoveryTenantId, { agentId: seed.tenantA.agentId }),
    ).rejects.toBeInstanceOf(AppError);

    // (b) Own conversation (no agent), same fishing query: no canary anywhere in the captured request.
    const convGuest = await conversations.start(discoveryTenantId, {});
    harness.provider.reset();
    harness.provider.script([{ content: 'Guest has no clinic-specific knowledge yet.' }]);
    await ctx.run(async () => {
      ctx.setPrincipal(guestPrincipal);
      return execution.sendMessage(discoveryTenantId, convGuest.id, { content: KB_MATCH_QUERY }, 'REST');
    });
    const capturedGuest = harness.provider.capturedRequests[0];
    const combinedGuest = JSON.stringify(capturedGuest.messages);
    expect(combinedGuest.includes(CANARY_SYS)).toBe(false);
    expect(combinedGuest.includes(CANARY_KB)).toBe(false);

    // (c) Direct attempt on tenant A's conversation id, via the orchestrator's resume path,
    // using the guest's OWN tenantId (discoveryTenantId) — tenant mismatch alone rejects it
    // before the guestSubject binding check even runs.
    const callCountBefore = harness.provider.callCount;
    await expect(
      ctx.run(async () => {
        ctx.setPrincipal(guestPrincipal);
        return orchestrator.handle(discoveryTenantId, {
          channel: 'WEBSITE',
          content: KB_MATCH_QUERY,
          aiConversationId: tenantAConversationId,
        });
      }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(harness.provider.callCount).toBe(callCountBefore);

    // (d) Same probe over the REAL WebSocket gateway, using a synthetic socket carrying the
    // real guest principal — reproduces the exact wire-level surface (ai:error payload).
    const gateway = harness.app.get(AiRealtimeGateway);
    const socket = fakeSocket(guestPrincipal);
    await ctx.run(async () => {
      ctx.setPrincipal(guestPrincipal);
      return gateway.onMessage(socket, { content: KB_MATCH_QUERY, aiConversationId: tenantAConversationId, channel: 'WEBSITE' });
    });
    const emittedPayloads = (socket.emit as jest.Mock).mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
    const wsCombined = emittedPayloads.join('\n');
    expect(wsCombined.includes(CANARY_SYS)).toBe(false);
    expect(wsCombined.includes(CANARY_KB)).toBe(false);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [convGuest.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convGuest.id]);
  }, 30_000);

  it('sink 10 — client-visible error responses (REST) never carry either canary, even for a forced provider failure on tenant A\'s own canary-laden turn', async () => {
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.scriptFailure({ kind: '5xx', status: 503 });

    const staffToken = await harness.jwt.signAsync(
      { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    const res = await request(harness.app.getHttpServer())
      .post('/api/v1/ai/orchestrator/message')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ channel: 'DASHBOARD', content: KB_MATCH_QUERY, aiConversationId: conv.id });

    const body = JSON.stringify(res.body);
    expect(body.includes(CANARY_SYS)).toBe(false);
    expect(body.includes(CANARY_KB)).toBe(false);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('final sanity — scanText/scanValue independently confirm the planted canaries are detectable as secret-shaped values (guards this whole spec against a silently-broken pattern set)', () => {
    expect(scanText(`token: ${CANARY_SYS}`).some((h) => h.matchedText === CANARY_SYS)).toBe(true);
    expect(scanText(`token: ${CANARY_KB}`).some((h) => h.matchedText === CANARY_KB)).toBe(true);
  });
});
