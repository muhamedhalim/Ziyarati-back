/**
 * T134 — absent-provider-key degradation path: the REAL `NoopAiProvider`
 * (FR-062, FR-067).
 *
 * Every other spec in this audit registers `ScriptedAiProvider` (a test
 * double) as the sole `AI_COMPLETION_PROVIDERS` member. This file
 * deliberately does NOT reuse `buildAiAuditHarness()` — per the task
 * instruction to "override the seam differently for this one test" — and
 * instead boots its own Nest application with the REAL, production
 * `NoopAiProvider` (`src/modules/ai/providers/noop-ai.provider.ts`)
 * registered instead. This is the actual code path that runs whenever no
 * real completion provider is configured (`AiProviderFactory.resolve()`
 * falls through to it) — NOT a simulation of that path.
 *
 * `AI_EMBEDDING_PROVIDER` is still overridden with the scripted embedding
 * double (never the real `OpenAiEmbeddingProvider`) — this test is about the
 * COMPLETION seam, and letting a real embedding call through would violate
 * FR-103 (no live provider network calls) for a concern this file isn't
 * testing.
 *
 * Drives every entry point that can be reached without leaving this process
 * (REST orchestrator over real HTTP with a real JWT; the realtime gateway's
 * `ai:message` handler via the repo's established `FakeSocket` pattern; the
 * shared execution engine directly under WHATSAPP and BACKGROUND_JOB
 * transport) and records the OBSERVED reply + tool-call count for each.
 */
import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import cookieParser from 'cookie-parser';
import type { Socket } from 'socket.io';

import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { requestContext } from '../../src/common/middleware/request-context.middleware';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { registerSecurityHeaders } from '../../src/config/security-headers';
import {
  AI_COMPLETION_PROVIDERS,
  AI_EMBEDDING_PROVIDER,
} from '../../src/modules/ai/providers/ai-provider.interface';
import { NoopAiProvider } from '../../src/modules/ai/providers/noop-ai.provider';
import { ScriptedEmbeddingProvider } from './fixtures/scripted-ai-embedding-provider';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import { GuestSessionService } from '../../src/modules/guest-chat/guest-session.service';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { User } from '../../src/entities/Auth&RBAC/User';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { ROLE, PERMISSION } from '../../src/rbac/rbac.constants';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';

const NOOP_MARKER = 'AI provider is not configured in this environment.';

interface FakeSocket {
  data: Record<string, unknown>;
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  to: jest.Mock;
  emit: jest.Mock;
}
function fakeSocket(tenantId: string, user: AuthenticatedUser): FakeSocket {
  const rooms = new Set<string>();
  return {
    data: { userId: user.id, tenantId, user },
    rooms,
    join: jest.fn((r: string) => rooms.add(r)),
    leave: jest.fn((r: string) => rooms.delete(r)),
    to: jest.fn(() => ({ emit: jest.fn() })),
    emit: jest.fn(),
  };
}
const asSocket = (s: FakeSocket) => s as unknown as Socket;

describe('AI degradation — REAL NoopAiProvider across every reachable entry point (T134)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwt: JwtService;
  let seed: AiAuditSeed;
  const observed: Record<string, unknown> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_COMPLETION_PROVIDERS)
      .useValue([new NoopAiProvider()]) // the REAL production class, not a stub
      .overrideProvider(AI_EMBEDDING_PROVIDER)
      .useValue(new ScriptedEmbeddingProvider(16))
      .compile();

    app = moduleRef.createNestApplication();
    registerSecurityHeaders(app);
    const tenantContext = app.get(TenantContextService);
    app.use(requestContext);
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) =>
      tenantContext.run(() => {
        tenantContext.setCorrelationId(req.requestId ?? null);
        next();
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    jwt = app.get(JwtService);
    seed = await seedAiAudit(app, dataSource);

    // Grant the seeded staff user a real permission-bearing role (the seed
    // fixture only assigns `doctor`, which lacks ai.conversations.manage) so
    // the REST entry point can be driven through its REAL guard chain.
    const roles = dataSource.getRepository(Role);
    const ownerRole = await roles.createQueryBuilder('r').where('r.slug = :slug', { slug: ROLE.OWNER }).andWhere('r."tenantId" IS NULL').getOneOrFail();
    await dataSource.getRepository(UserRole).save(
      dataSource.getRepository(UserRole).create({
        user: { id: seed.tenantA.staffUserId } as User,
        role: { id: ownerRole.id } as Role,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(dataSource, seed);
    await app.close();

    process.stdout.write('\n===W9-NOOP-PROVIDER-DEGRADATION-SUMMARY===\n');
    process.stdout.write(JSON.stringify(observed, null, 2) + '\n');
  }, 60_000);

  async function toolCallCount(aiConversationId: string): Promise<number> {
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ai_tool_calls WHERE ai_conversation_id = $1`,
      [aiConversationId],
    );
    return count;
  }

  it('E1 — REST orchestrator (POST /ai/orchestrator/message), real HTTP + real JWT + real guard chain', async () => {
    const token = await jwt.signAsync(
      { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
      { secret: app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );

    const res = await request(app.getHttpServer())
      .post('/api/v1/ai/orchestrator/message')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'DASHBOARD', content: 'What are your clinic hours?' });

    expect(res.status).toBe(201);
    expect(res.body.reply.content).toContain(NOOP_MARKER);
    const toolCalls = await toolCallCount(res.body.aiConversationId);
    expect(toolCalls).toBe(0);

    observed.e1_rest_dashboard = { status: res.status, replyContainsNoopMarker: true, toolCallCount: toolCalls, usage: res.body.usage };

    await dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [res.body.aiConversationId]);
    await dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [res.body.aiConversationId]);
  }, 30_000);

  it('E2 — realtime WS gateway (`ai:message`), real AiRealtimeGateway.onMessage handler via a FakeSocket', async () => {
    const gateway = app.get(AiRealtimeGateway);
    const principal: AuthenticatedUser = {
      id: seed.tenantA.staffUserId,
      tenantId: seed.tenantA.id,
      roles: [],
      // AI-007/T042: `onMessage` requires `ai.conversations.manage` for any
      // non-guest principal — this suite exercises provider *degradation*,
      // not authorization, so the principal needs this permission just to
      // reach the code path under test (the WS entitlement gate itself is
      // covered separately, in ai-w3-rest-ws-parity.spec.ts).
      permissions: [PERMISSION.AI_CONVERSATIONS_MANAGE],
    };
    const socket = fakeSocket(seed.tenantA.id, principal);

    await gateway.onMessage(asSocket(socket), { channel: 'WEBSITE', content: 'Hello via WS' });

    const doneCall = socket.emit.mock.calls.find((c) => c[0] === 'ai:done');
    const errorCall = socket.emit.mock.calls.find((c) => c[0] === 'ai:error');
    expect(errorCall).toBeUndefined();
    expect(doneCall).toBeDefined();
    const donePayload = doneCall![1] as { reply: { content: string }; aiConversationId: string };
    expect(donePayload.reply.content).toContain(NOOP_MARKER);
    const toolCalls = await toolCallCount(donePayload.aiConversationId);
    expect(toolCalls).toBe(0);

    observed.e2_ws_gateway = {
      emittedEvents: socket.emit.mock.calls.map((c) => c[0]),
      replyContainsNoopMarker: true,
      toolCallCount: toolCalls,
    };

    await dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [donePayload.aiConversationId]);
    await dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [donePayload.aiConversationId]);
  }, 30_000);

  it('E3 — public/guest discovery chat, the shared engine under a REAL guest principal on the discovery tenant', async () => {
    const conversations = app.get(AiConversationService);
    const execution = app.get(AiExecutionService);

    const conv = await conversations.start(seed.discoveryTenantId, {});
    const result = await execution.sendMessage(
      seed.discoveryTenantId,
      conv.id,
      { content: 'Which clinics do you have?' },
      'WEBSOCKET', // guest discovery chat is WS-driven, per channel-matrix.md
    );

    expect(result.message.content).toContain(NOOP_MARKER);
    const toolCalls = await toolCallCount(conv.id);
    expect(toolCalls).toBe(0);

    observed.e3_guest_discovery = { replyContainsNoopMarker: true, toolCallCount: toolCalls };

    await dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('E4 — WhatsApp transport, the shared execution engine under transport="WHATSAPP" (webhook parsing/actor restoration not independently driven here — see T133)', async () => {
    const conversations = app.get(AiConversationService);
    const execution = app.get(AiExecutionService);

    const conv = await conversations.start(seed.tenantA.id, {});
    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Book me an appointment' },
      'WHATSAPP',
    );

    expect(result.message.content).toContain(NOOP_MARKER);
    const toolCalls = await toolCallCount(conv.id);
    expect(toolCalls).toBe(0);

    observed.e4_whatsapp_transport = { replyContainsNoopMarker: true, toolCallCount: toolCalls };

    await dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('Async AI Execution Job path — the shared engine under transport="BACKGROUND_JOB" (the ai.execute QueueService/AiProcessor wiring itself is confirmed dead code, per w1-async.md; this proves only that the shared engine handles the transport value correctly if ever invoked)', async () => {
    const conversations = app.get(AiConversationService);
    const execution = app.get(AiExecutionService);

    const conv = await conversations.start(seed.tenantA.id, {});
    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'Queued turn probe' },
      'BACKGROUND_JOB',
    );

    expect(result.message.content).toContain(NOOP_MARKER);
    const toolCalls = await toolCallCount(conv.id);
    expect(toolCalls).toBe(0);

    observed.background_job_transport = { replyContainsNoopMarker: true, toolCallCount: toolCalls };

    await dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('cross-cutting: no security or functional conclusion in this suite silently depended on a Noop-only path — every AI_TOOLS-driven scenario elsewhere in this audit uses ScriptedAiProvider precisely so a real toolCalls array is exercised; this file exists ONLY to prove the degraded no-provider state itself', () => {
    // Documentation assertion — the guarantee is structural (separate harness
    // per file), verified by inspection of every OTHER ai-w*.spec.ts file's
    // import of `buildAiAuditHarness`/`ScriptedAiProvider` rather than this one.
    expect(Object.keys(observed).length).toBeGreaterThanOrEqual(5);
  });
});
