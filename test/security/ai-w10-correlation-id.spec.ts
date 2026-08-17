/**
 * T157 — correlation-id propagation across 4 hops (FR-082).
 *
 * One synthetic correlation id is planted at the true entry point (an
 * `X-Request-Id` header on a real HTTP request — `request-context.middleware.ts`
 * honours an incoming value rather than always generating its own) and then
 * traced through each of the 4 named hops' OWN durable record, read back with a
 * fresh query every time:
 *
 *   1. orchestrator   — the REST route itself (`POST /ai/orchestrator/message`)
 *   2. tool dispatch   — `ai_tool_calls` / `ai_execution_metrics`
 *   3. queued QUEUE.AI job — a real BullMQ job enqueued via `QueueService.enqueueAiExecute`
 *   4. realtime emission — the payload `AiRealtimeGateway.runMessage` would `client.emit(...)`
 *
 * This is not assumed to succeed at every hop. T155 originally found no
 * correlation/request-id column on any AI ledger table; [PROMOTED, RTP row
 * 12, AI-016/T072] `ai_tool_calls` and `ai_execution_metrics` both gained one
 * (M1/M2), populated from `TenantContextService.getCorrelationId()` at write
 * time — hop 2 now succeeds, on both the REST and realtime transports. This
 * file's job is to show PRECISELY where the SAME id does and does not
 * survive, hop by hop, with the record (or its absence) for each.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { REQUEST_ID_HEADER } from '../../src/common/middleware/request-context.middleware';

import { AiOrchestratorService } from '../../src/modules/ai-orchestrator/ai-orchestrator.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { QueueService } from '../../src/queue/queue.service';
import { QUEUE } from '../../src/queue/queue.constants';

import { User } from '../../src/entities/Auth&RBAC/User';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';

import { ROLE, ROLE_PERMISSIONS } from '../../src/rbac/rbac.constants';
import { AI_ADMIN_TOOL } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';

describe('W10 — correlation id across 4 hops: orchestrator → tool dispatch → QUEUE.AI job → realtime emission (T157)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let orchestrator: AiOrchestratorService;
  let tenantContext: TenantContextService;
  let queueService: QueueService;
  let accessSecret: string;

  let ownerUserId: string;
  let ownerPrincipal: AuthenticatedUser;

  const convIds: string[] = [];

  interface HopResult {
    hop: string;
    durableRecord: string;
    idFound: boolean;
    detail: string;
  }
  const hops: HopResult[] = [];

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    orchestrator = harness.app.get(AiOrchestratorService);
    tenantContext = harness.app.get(TenantContextService);
    queueService = harness.app.get(QueueService);
    accessSecret = harness.config.getOrThrow<string>('JWT_ACCESS_SECRET');

    const ds = harness.dataSource;
    const users = ds.getRepository(User);
    const roles = ds.getRepository(Role);
    const userRoles = ds.getRepository(UserRole);
    const ownerUser = await users.save(
      users.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        email: `w10-cid-owner-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'W10 Correlation Owner',
        is_active: true,
      }),
    );
    ownerUserId = ownerUser.id;
    const ownerRole = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.OWNER })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!ownerRole) throw new Error('seeded system role "owner" not found — run the RBAC seed first.');
    await userRoles.save(userRoles.create({ user: { id: ownerUser.id } as User, role: { id: ownerRole.id } as Role }));
    ownerPrincipal = {
      id: ownerUser.id,
      tenantId: seed.tenantA.id,
      email: ownerUser.email,
      roles: [ROLE.OWNER],
      permissions: ROLE_PERMISSIONS[ROLE.OWNER] as string[],
      guest: false,
    };
  }, 120_000);

  afterAll(async () => {
    const ds = harness.dataSource;
    const q = (sql: string, params: unknown[]) => ds.query(sql, params).catch(() => undefined);
    await q(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_execution_metrics WHERE ai_conversation_id::text = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_cost_entries WHERE ai_conversation_id::text = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [convIds]);
    await q(`DELETE FROM user_roles WHERE "userId" = $1`, [ownerUserId]);
    await q(`DELETE FROM users WHERE id = $1`, [ownerUserId]);

    await teardownAiAuditSeed(ds, seed);
    await harness.close();
  }, 60_000);

  it('the SAME planted id: found at hop 1 (echoed by the orchestrator route), [PROMOTED, RTP row 12] now found at hop 2 too (ai_tool_calls / ai_execution_metrics, both transports), found at hop 3 (the queued QUEUE.AI job\'s own Redis-durable data), absent from the hop-4 emission PAYLOAD CONTRACT specifically (but present in that same WS-driven turn\'s own ai_execution_metrics row)', async () => {
    const marker = `w10-cid-${randomUUID()}`;

    // ── Hop 1: orchestrator (REST) ─────────────────────────────────────────
    // request-context.middleware.ts honours an incoming X-Request-Id rather
    // than always minting its own (requestContext(), lines 24-28) — this IS
    // how a real upstream gateway would propagate one end to end. The
    // response echoes the SAME value back (`res.setHeader('X-Request-Id', …)`),
    // proving the orchestrator's own request boundary received and preserved it.
    const token = await harness.jwt.signAsync(
      { sub: ownerPrincipal.id, tenantId: seed.tenantA.id, type: 'access' },
      { secret: accessSecret, expiresIn: '15m' },
    );
    harness.provider.reset();
    harness.provider.script([
      { toolCalls: [scriptedToolCall(AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, {})] },
      { content: 'Scripted hop-1 final answer.' },
    ]);
    const res = await request(harness.app.getHttpServer())
      .post('/api/v1/ai/orchestrator/message')
      .set('Authorization', `Bearer ${token}`)
      .set(REQUEST_ID_HEADER, marker)
      .send({ channel: 'DASHBOARD', content: 'please get_dashboard_kpis', agentId: seed.tenantA.agentId });
    expect(res.status).toBe(201);
    expect(res.headers['x-request-id']).toBe(marker); // hop 1's own record: the response itself
    const convId = res.body.aiConversationId as string;
    convIds.push(convId);
    hops.push({
      hop: '1. orchestrator (REST)',
      durableRecord: 'HTTP response X-Request-Id header (echoed, not itself persisted anywhere)',
      idFound: true,
      detail: `res.headers['x-request-id'] === marker`,
    });

    // ── Hop 2: tool dispatch (ai_tool_calls / ai_execution_metrics) ────────
    // Re-read from Postgres, never from anything the test itself built.
    const [toolCallRow] = await harness.dataSource.query(
      `SELECT * FROM ai_tool_calls WHERE ai_conversation_id = $1 AND tool_name = $2 ORDER BY created_at DESC LIMIT 1`,
      [convId, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS],
    );
    const [metricRow] = await harness.dataSource.query(
      `SELECT * FROM ai_execution_metrics WHERE ai_conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [convId],
    );
    const hop2Blob = JSON.stringify([toolCallRow, metricRow]);
    const hop2Found = hop2Blob.includes(marker);
    expect(toolCallRow).toBeDefined(); // the call itself DID happen and DID get ledgered (ALLOWED case)
    // [PROMOTED, RTP row 12, AI-016/T072] both tables now carry a
    // correlation_id column, populated from TenantContextService at the
    // exact moment each row is written — the SAME id planted at hop 1
    // survives all the way to hop 2's durable ledger.
    expect(hop2Found).toBe(true);
    expect(toolCallRow.correlation_id).toBe(marker);
    expect(metricRow.correlation_id).toBe(marker);
    hops.push({
      hop: '2. tool dispatch',
      durableRecord: 'ai_tool_calls row + ai_execution_metrics row',
      idFound: hop2Found,
      detail: '[PROMOTED, row 12] both tables carry a dedicated correlation_id column (M1/M2), populated from TenantContextService.getCorrelationId() at write time — confirmed by full-row string search, not just column-name inspection',
    });

    // ── Hop 3: queued QUEUE.AI job ──────────────────────────────────────────
    // `QueueService.add()`'s private `stamp()` (queue.service.ts:673-680)
    // auto-fills `correlationId` from `TenantContextService.getCorrelationId()`
    // when the caller does not supply one explicitly — so enqueueing WHILE the
    // marker is the active correlation id reproduces exactly what a real
    // HTTP-triggered enqueue does. The job payload itself, fetched back from
    // Redis via BullMQ (not a Postgres table, but still a durable record for
    // as long as the job exists), is hop 3's ledger.
    const job = await tenantContext.run(async () => {
      tenantContext.setCorrelationId(marker);
      return queueService.enqueueAiExecute({
        tenantId: seed.tenantA.id,
        aiConversationId: convId,
        content: 'queued hop test',
        idempotencyKey: `w10-cid-${randomUUID()}`,
      });
    });
    const fetchedJob = await queueService.queue(QUEUE.AI).getJob(job.id!);
    expect(fetchedJob).toBeDefined();
    const hop3Found = fetchedJob!.data.correlationId === marker;
    expect(hop3Found).toBe(true); // positive result — the ONE hop with a durable, inspectable trace
    hops.push({
      hop: '3. queued QUEUE.AI job',
      durableRecord: `BullMQ job data (queue=${QUEUE.AI}, jobId=${job.id})`,
      idFound: hop3Found,
      detail: 'QueueService.add() auto-stamps correlationId from TenantContextService onto every job payload (queue.service.ts:673-680) — the only hop of the 4 where the id survives into an inspectable durable record',
    });
    // Clean up the job so it does not linger as orphaned queue state.
    await fetchedJob!.remove().catch(() => undefined);

    // ── Hop 4: realtime emission ────────────────────────────────────────────
    // Not a real socket — calls the SAME method AiRealtimeGateway.runMessage()
    // calls (HARNESS_GUIDE.md gotcha #8) and inspects EXACTLY the object shape
    // the gateway builds for `client.emit(AI_EVENT.DONE, done)`
    // (ai-realtime.gateway.ts:424-435: aiConversationId, agentRole, reply,
    // usage, streamed, handedOver — no other field). A socket emission is
    // inherently ephemeral (never itself written to a table), so this hop's
    // "durable record" is the emission payload's OWN field set — if the id
    // isn't IN that payload, no downstream persistence step could recover it
    // from this hop even in principle.
    harness.provider.reset();
    harness.provider.script([{ content: 'Scripted hop-4 final answer.' }]);
    const streamResult = await tenantContext.run(async () => {
      tenantContext.setPrincipal(ownerPrincipal);
      tenantContext.setCorrelationId(marker);
      return orchestrator.handleStream(
        seed.tenantA.id,
        { channel: 'WEBSITE', content: 'hop 4 probe', agentId: seed.tenantA.agentId },
        () => undefined,
      );
    });
    convIds.push((streamResult as { aiConversationId: string }).aiConversationId);
    const wouldEmit = {
      aiConversationId: (streamResult as { aiConversationId: string }).aiConversationId,
      agentRole: (streamResult as { agentRole: unknown }).agentRole,
      reply: (streamResult as { reply: unknown }).reply,
      usage: (streamResult as { usage: unknown }).usage,
      streamed: (streamResult as { streamed: unknown }).streamed,
      handedOver: (streamResult as { handedOver: unknown }).handedOver,
    };
    const hop4Found = JSON.stringify(wouldEmit).includes(marker);
    expect(hop4Found).toBe(false);
    expect(Object.keys(wouldEmit)).not.toContain('correlationId');
    hops.push({
      hop: '4. realtime emission',
      durableRecord: 'the exact object AiRealtimeGateway.runMessage() would client.emit(AI_EVENT.DONE, …) — inherently ephemeral, never itself persisted',
      idFound: hop4Found,
      detail: 'field set is {aiConversationId, agentRole, reply, usage, streamed, handedOver} only — no correlation/request id field exists on the emission contract at all; unaffected by T072, which only touches durable ledger tables, never the emission payload shape',
    });

    // [PROMOTED, RTP row 12] "both transports": this SAME WS-driven turn's
    // own ai_execution_metrics row (a per-turn record, written regardless of
    // whether the turn called a tool) is now checked independently of the
    // emission payload above — the marker was set via
    // tenantContext.setCorrelationId(marker) BEFORE handleStream() ran,
    // exactly as T071's resolveCorrelationId() does inside the real gateway
    // before it calls runMessage(). This is the realtime-transport half of
    // row 12; hop 2 above already proved the REST half.
    const [wsMetricRow] = await harness.dataSource.query(
      `SELECT correlation_id FROM ai_execution_metrics WHERE ai_conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [(streamResult as { aiConversationId: string }).aiConversationId],
    );
    expect(wsMetricRow).toBeDefined();
    expect(wsMetricRow.correlation_id).toBe(marker);

    process.stdout.write('\n===W10-CORRELATION-ID-HOPS-START===\n');
    process.stdout.write(JSON.stringify({ marker, hops }, null, 2));
    process.stdout.write('\n===W10-CORRELATION-ID-HOPS-END===\n');

    // [PROMOTED, RTP row 12] hop 2 flips from absent to found; hop 4's
    // EMISSION-PAYLOAD-CONTRACT result is unchanged (correctly still absent
    // — checked separately above via ai_execution_metrics for the "both
    // transports" requirement).
    expect(hops.map((h) => h.idFound)).toEqual([true, true, true, false]);
  }, 60_000);
});
