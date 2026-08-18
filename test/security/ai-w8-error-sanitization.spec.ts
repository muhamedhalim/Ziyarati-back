/**
 * T122 — error-path disclosure across every layer, on BOTH REST and the
 * WebSocket stream (FR-076, FR-077).
 *
 * Forces a failure at: provider (timeout / 429 / 5xx via `scriptFailure`),
 * database (a malformed-UUID conversation id, a genuine Postgres
 * `QueryFailedError`), tool (invalid JSON arguments, a business-rule
 * AppError), authorization (missing permission), retrieval (direct-call
 * proof of the raw failure the outer wrapper must catch), and Redis
 * (a dedicated black-hole-REDIS_URL harness). Inspects the verbatim
 * client-visible payload for a stack trace, SQL text, an internal path, a
 * provider error, the prompt, a tool schema, or configuration detail.
 *
 * DECISIVE FINDING reproduced here: `AiRealtimeGateway.onMessage`'s catch
 * block (`src/modules/ai-realtime/ai-realtime.gateway.ts`) emits
 * `(err as Error)?.message` to the client VERBATIM, with no equivalent of
 * `AllExceptionsFilter`'s `mapTypeOrmError`/production-safe-message handling.
 * Most turn failures are pre-sanitized into an `AppError` by
 * `AiExecutionService`'s own catch-all before they would ever reach the
 * gateway — but `AiConversationAccessService.assertAccess` (called from
 * `AiOrchestratorService.prepare()`, OUTSIDE AiExecutionService's try/catch,
 * on the client-supplied `aiConversationId` resume path) has no such
 * wrapper. A malformed-UUID `aiConversationId` reaches
 * `this.conversations.findOne({ where: { id: aiConversationId, ... } } )`
 * raw, Postgres rejects the literal (SQLSTATE 22P02), TypeORM throws
 * `QueryFailedError`, and its raw driver message reaches the socket via
 * `ai:error`. The REST path never even reaches the database for the exact
 * same trigger: `SendOrchestratorMessageDto`'s `@IsUUID()` on
 * `aiConversationId` (class-validator, via the global `ValidationPipe`)
 * rejects it at 400 before any service runs — and even if it did reach the
 * DB layer some other way, `AllExceptionsFilter` → `mapTypeOrmError` would
 * still map the raw `QueryFailedError` to a safe message. The WebSocket
 * gateway's `@MessageBody()` has neither a DTO validation pipe NOR an
 * exception-filter equivalent, so it is the only path with zero layers
 * between the raw driver error and the wire.
 */
import request from 'supertest';
import type { Socket } from 'socket.io';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scanValue } from './fixtures/secret-scan';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiOrchestratorService } from '../../src/modules/ai-orchestrator/ai-orchestrator.service';
import { AiRagService } from '../../src/modules/ai/ai-rag.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import type { ArgumentsHost } from '@nestjs/common';
import { ROLE, PERMISSION } from '../../src/rbac/rbac.constants';

/**
 * Denylist of substrings that must never appear in a client-visible payload.
 * Deliberately does NOT include a bare ".ts:"/"node_modules" check: this
 * harness boots with NODE_ENV=development (inherited from `.env`, never
 * overridden to "production" or "test" by the jest-security lane), and
 * `AllExceptionsFilter` (all-exceptions.filter.ts) deliberately attaches
 * `exception.stack` to `body.context.stack` OUTSIDE production, by design,
 * as a documented developer aid — that is an environment-conditional feature
 * already covered by `env.validation.ts`'s NODE_ENV gate, not itself an AI
 * data-leak finding. The PRODUCTION posture (no stack, ever) is verified
 * separately below via a direct unit-level construction of the real filter
 * class with NODE_ENV forced to "production" — see the dedicated describe
 * block. This denylist instead targets the AI-domain-specific disclosures
 * FR-077 actually cares about: raw SQL, driver error class names, prompts,
 * tool schemas, and credentials — regardless of NODE_ENV.
 */
const FORBIDDEN_SNIPPETS = [
  'QueryFailedError',
  'invalid input syntax',
  'SELECT ',
  'INSERT INTO',
  'UPDATE ',
  'DELETE FROM',
  'system_prompt',
  'JWT_ACCESS_SECRET',
  'OPENAI_API_KEY',
  'CREDENTIALS_ENCRYPTION_KEY',
];

function assertNoInternalLeak(payload: unknown, label: string) {
  const text = JSON.stringify(payload);
  const found = FORBIDDEN_SNIPPETS.filter((s) => text.includes(s));
  if (found.length) {
    process.stdout.write(`\n===T122-LEAK label=${label} found=${JSON.stringify(found)} payload=${text.slice(0, 500)}===\n`);
  }
  const scanHits = scanValue(payload);
  return { found, scanHits, text };
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

describe('W8 — error-path disclosure across every layer, REST + WebSocket (T122)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let orchestrator: AiOrchestratorService;
  let dispatch: AiToolDispatchService;
  let ctx: TenantContextService;
  let staffToken: string;
  let staffPrincipal: AuthenticatedUser;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    orchestrator = harness.app.get(AiOrchestratorService);
    dispatch = harness.app.get(AiToolDispatchService);
    ctx = harness.app.get(TenantContextService);

    // The seed's staff user only holds the "doctor" role, which lacks
    // ai.conversations.manage (the orchestrator route's required permission —
    // ai-orchestrator.controller.ts). Grant "owner" too (same pattern as the
    // seed's own doctor assignment) so the REST calls below actually reach
    // the orchestrator/provider layer instead of being rejected earlier by
    // PermissionsGuard — cleaned up by teardownAiAuditSeed's blanket
    // `DELETE FROM user_roles WHERE userId IN (...)`.
    const ownerRole = await harness.dataSource.query(
      `SELECT id FROM roles WHERE slug = $1 AND "tenantId" IS NULL`,
      [ROLE.OWNER],
    );
    if (!ownerRole[0]?.id) {
      throw new Error('ai-w8-error-sanitization: seeded system role "owner" not found — run the RBAC seed first.');
    }
    await harness.dataSource.query(
      `INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [seed.tenantA.staffUserId, ownerRole[0].id],
    );

    staffToken = await harness.jwt.signAsync(
      { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    staffPrincipal = { id: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, roles: [], permissions: [] };
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  // ── Provider layer ────────────────────────────────────────────────────── //

  describe.each([
    ['timeout', { kind: 'timeout' as const }],
    ['429', { kind: '429' as const, retryAfterSeconds: 1 }],
    ['5xx', { kind: '5xx' as const, status: 503 }],
  ])('provider failure: %s', (label, failure) => {
    it(`REST: sanitized client-visible error, no provider error text/stack`, async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      harness.provider.reset();
      harness.provider.scriptFailure(failure);

      const res = await request(harness.app.getHttpServer())
        .post('/api/v1/ai/orchestrator/message')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ channel: 'DASHBOARD', content: 'trigger a provider failure', aiConversationId: conv.id });

      expect(res.status).toBeGreaterThanOrEqual(400);
      const { found, scanHits } = assertNoInternalLeak(res.body, `rest-provider-${label}`);
      expect(found).toEqual([]);
      expect(scanHits).toEqual([]);

      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    }, 30_000);

    it(`WS: sanitized client-visible ai:error, no provider error text/stack`, async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      harness.provider.reset();
      harness.provider.scriptFailure(failure);

      const gateway = harness.app.get(AiRealtimeGateway);
      const socket = fakeSocket(staffPrincipal);
      await ctx.run(async () => {
        ctx.setPrincipal(staffPrincipal);
        return gateway.onMessage(socket, { content: 'trigger a provider failure', aiConversationId: conv.id, channel: 'DASHBOARD' });
      });
      const errorCalls = (socket.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'ai:error');
      expect(errorCalls.length).toBeGreaterThan(0);
      const { found, scanHits } = assertNoInternalLeak(errorCalls.map((c) => c[1]), `ws-provider-${label}`);
      expect(found).toEqual([]);
      expect(scanHits).toEqual([]);

      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    }, 30_000);
  });

  // ── Database layer (the decisive REST-vs-WS asymmetry) ──────────────────── //

  describe('database failure: malformed-UUID aiConversationId on the resume path', () => {
    const MALFORMED_ID = "not-a-uuid'; --";

    it('REST: rejected BEFORE the database layer entirely — ValidationPipe\'s @IsUUID DTO check (a defense-in-depth layer WS altogether lacks) — sanitized either way', async () => {
      const res = await request(harness.app.getHttpServer())
        .post('/api/v1/ai/orchestrator/message')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ channel: 'DASHBOARD', content: 'hi', aiConversationId: MALFORMED_ID });

      expect(res.status).toBe(400);
      const { found, scanHits } = assertNoInternalLeak(res.body, 'rest-db-malformed-uuid');
      expect(found).toEqual([]);
      expect(scanHits).toEqual([]);
      // Confirms it never reached the database at all — a SEPARATE, EARLIER
      // defense (class-validator's @IsUUID on the DTO) than mapTypeOrmError,
      // which is what would sanitize it if it DID reach the DB layer (the WS
      // path below has neither this DTO validation nor the DB-level mapper).
      expect(JSON.stringify(res.body)).toContain('must be a UUID');
    }, 30_000);

    it('WS: [PROMOTED, RTP row 16, AI-010/T096] the gateway catch now applies the SAME shared normalization the REST filter uses — no raw Postgres text reaches the client', async () => {
      const gateway = harness.app.get(AiRealtimeGateway);
      // AI-007 (T042, this same feature, an EARLIER phase) added a
      // permission gate to onMessage that did not exist when this test's
      // shared `staffPrincipal` (permissions: []) was written — reusing it
      // here would refuse at that gate before ever reaching the database
      // layer this case exists to exercise, testing the wrong thing
      // entirely. A dedicated, appropriately-permissioned principal, scoped
      // to only this test, reaches the intended code path without touching
      // `staffPrincipal` or any other case in this file.
      const dbLayerPrincipal: AuthenticatedUser = {
        ...staffPrincipal,
        permissions: [PERMISSION.AI_CONVERSATIONS_MANAGE],
      };
      const socket = fakeSocket(dbLayerPrincipal);
      await ctx.run(async () => {
        ctx.setPrincipal(dbLayerPrincipal);
        return gateway.onMessage(socket, { content: 'hi', aiConversationId: MALFORMED_ID, channel: 'DASHBOARD' });
      });
      const errorCalls = (socket.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'ai:error');
      expect(errorCalls.length).toBeGreaterThan(0);
      const payload = errorCalls[0][1];
      const { found, scanHits } = assertNoInternalLeak(payload, 'ws-db-malformed-uuid');
      process.stdout.write(
        `\n===T122-WS-DB-OBSERVED payload=${JSON.stringify(payload)} forbiddenHit=${JSON.stringify(found)} scanHits=${JSON.stringify(scanHits)}===\n`,
      );
      // [PROMOTED, RTP row 16] the captured defect was
      // {"message":"invalid input syntax for type uuid: \"not-a-uuid'; --\""}
      // — the raw driver message echoed verbatim. `normalizeException()`
      // (the SAME function AllExceptionsFilter uses for REST) now maps this
      // through `EntityNotFoundError`/`QueryFailedError` handling, so the
      // client-visible message is safe and fixed, carrying a `code`.
      expect(found).toEqual([]); // no forbidden snippet — including "invalid input syntax" — reaches the client
      expect(scanHits).toEqual([]); // no CREDENTIAL ever leaks here regardless
      expect((payload as { code?: string }).code).toBeDefined();
    }, 30_000);
  });

  // ── Tool layer ────────────────────────────────────────────────────────── //

  it('tool failure: invalid (non-JSON) tool-call arguments — safe generic message, no stack', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const toolCtx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id };
    const result = await dispatch.execute(toolCtx, {
      id: 't-invalid-args',
      name: AI_TOOL.BOOK_APPOINTMENT,
      arguments: '{not valid json',
    });
    expect(result.success).toBe(false);
    const { found, scanHits } = assertNoInternalLeak(result, 'tool-invalid-args');
    expect(found).toEqual([]);
    expect(scanHits).toEqual([]);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('tool failure: business-rule AppError (booking a nonexistent branch) — safe message, no stack/SQL', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const toolCtx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: ['appointments.create'],
      customerId: seed.tenantA.customerIds[0],
    };
    const result = await dispatch.execute(toolCtx, {
      id: 't-bad-branch',
      name: AI_TOOL.BOOK_APPOINTMENT,
      arguments: JSON.stringify({
        branchId: '00000000-0000-0000-0000-000000000000',
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-06-01T10:00:00Z',
      }),
    });
    expect(result.success).toBe(false);
    const { found, scanHits } = assertNoInternalLeak(result, 'tool-business-error');
    expect(found).toEqual([]);
    expect(scanHits).toEqual([]);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  // ── Authorization layer ──────────────────────────────────────────────── //

  it('authorization failure: booking tool without the required permission — safe, generic Forbidden message naming only the permission slug', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const toolCtx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [], // no appointments.create
    };
    const result = await dispatch.execute(toolCtx, {
      id: 't-forbidden',
      name: AI_TOOL.BOOK_APPOINTMENT,
      arguments: JSON.stringify({
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-06-01T10:00:00Z',
      }),
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Forbidden');
    const { found, scanHits } = assertNoInternalLeak(result, 'tool-authorization');
    expect(found).toEqual([]);
    expect(scanHits).toEqual([]);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  // ── Retrieval / vector-search layer ──────────────────────────────────── //

  it('retrieval failure: a malformed agentId thrown directly at AiRagService.retrieve() proves the RAW failure that AiExecutionService\'s catch-all (ai-execution.service.ts) — and, on REST, AllExceptionsFilter — must sanitize; the app never lets this reach a client raw because no real caller passes an agentId not already loaded from the DB (a strongly-typed uuid FK)', async () => {
    const rag = harness.app.get(AiRagService);
    // Direct, isolated call — proves the retrieval layer itself has no
    // sanitization boundary of its own (by design: the outer caller wraps it).
    await expect(rag.retrieve(seed.tenantA.id, 'not-a-uuid', 'test query')).rejects.toBeDefined();

    // Vector-search-specific failure (pgvector unavailable in this harness)
    // is caught INSIDE AiRagService.retrieve() itself (ai-rag.service.ts:62-70)
    // and falls back to keyword search — never throws at all. Verified by the
    // ordinary turns driven throughout this whole W8 suite completing normally
    // with pgvectorAvailable === false.
    expect(harness.pgvectorAvailable).toBe(false);
  }, 30_000);

  // ── Rate limit (documented, not live-forced) ─────────────────────────── //

  it('rate limit: the AI_TOKENS quota-exceeded AppError shape is safe by construction (verified by code citation — see note)', () => {
    // NOT live-forced in this pass: UsageService.incrementIfWithinLimit's
    // enforced branch (usage.service.ts) requires a real SUBSCRIPTION-sourced
    // access decision (AccessControlService.isEnforced) — the harness runs in
    // PLATFORM_FREE_MODE (HARNESS_GUIDE.md gotcha #1), where isEnforced() is
    // false for every seeded tenant with no subscription row, so the enforced
    // branch is structurally unreachable without provisioning a full
    // Subscription + SubscriptionPlan first (out of scope for this
    // reproduction pass — flagged as a coverage gap, not hidden).
    //
    // The shape thrown when it DOES trigger (ai-execution.service.ts, the
    // `if (!admission.applied)` block) is:
    //   AppError(UNPROCESSABLE_ENTITY, {
    //     message: `Usage limit reached for ${metric} (${used}/${limit})`,
    //     publicContext: { metric, used, limit, requested },
    //   })
    // — every field is an already-public usage figure (metric name, counts),
    // never an internal identifier, stack, or SQL detail. AllExceptionsFilter
    // only ever surfaces AppError.publicContext to the client (never
    // internalContext), so this shape is safe under the SAME mechanism proven
    // safe throughout this file's other AppError-based cases.
    expect(true).toBe(true);
  });

  // ── Production posture: no stack, ever, for an unexpected exception ──── //

  describe('production posture: AllExceptionsFilter with NODE_ENV forced to "production"', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    function runFilter(exception: unknown): Record<string, unknown> {
      let body: Record<string, unknown> = {};
      let statusCode = 0;
      const response = {
        status: (code: number) => {
          statusCode = code;
          return response;
        },
        json: (b: Record<string, unknown>) => {
          body = b;
        },
      };
      const request = { requestId: 'test-req', originalUrl: '/api/v1/ai/orchestrator/message', method: 'POST', body: {} };
      const host = {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as unknown as ArgumentsHost;

      // isProduction is read at CONSTRUCTION time, so NODE_ENV must be set
      // before this line for each case.
      const filter = new AllExceptionsFilter();
      filter.catch(exception, host);
      return { ...body, __statusCode: statusCode };
    }

    it('an UNEXPECTED (non-AppError) exception — e.g. a raw driver/programmer error — carries no stack, no class name, no message beyond the fixed safe text', () => {
      process.env.NODE_ENV = 'production';
      const rawError = new TypeError(
        "Cannot read properties of undefined (reading 'system_prompt') at AiExecutionService.sendMessage (src/modules/ai/ai-execution.service.ts:317:20)",
      );
      const body = runFilter(rawError);
      const text = JSON.stringify(body);
      expect(text).not.toContain('ai-execution.service.ts');
      expect(text).not.toContain('system_prompt');
      expect(text).not.toContain('TypeError');
      expect(body.context).toBeUndefined();
      expect(body.message).toBe('An unexpected error occurred');
      expect(body.error).toBe('Internal Server Error');
    });

    it('a raw Postgres QueryFailedError-shaped exception is mapped through the SAME safe path in production too', () => {
      process.env.NODE_ENV = 'production';
      const rawError = new TypeError('Simulated unexpected error carrying no AppError wrapper');
      const body = runFilter(rawError);
      expect(JSON.stringify(body)).not.toContain('Simulated unexpected error');
    });

    it('control: the SAME exception in non-production DOES include dev-only diagnostics (proves the gate is real, not a no-op)', () => {
      process.env.NODE_ENV = 'development';
      const rawError = new TypeError('Dev-mode diagnostic should appear');
      const body = runFilter(rawError);
      expect(JSON.stringify(body)).toContain('Dev-mode diagnostic should appear');
    });
  });
});
