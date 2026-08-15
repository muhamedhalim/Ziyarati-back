/**
 * T156 — refusal/failure recording reliability (FR-081).
 *
 * Confirms whether refused and failed tool calls are recorded in `ai_tool_calls`
 * AS RELIABLY as successful ones, across three entry points into the exact same
 * dispatcher code: (a) `AiToolDispatchService.execute` called directly, (b) a
 * real turn driven over REST (`POST /api/v1/ai/orchestrator/message`), and
 * (c) a real turn driven the way the `/ai` WebSocket gateway drives it
 * (`AiOrchestratorService.handleStream`, transport `'WEBSOCKET'` — the exact
 * method `AiRealtimeGateway.runMessage` calls; see HARNESS_GUIDE.md gotcha #8
 * for why a real socket connection is unnecessary to exercise this code path
 * for real).
 *
 * Three outcome classes are compared, not two, because W3's static analysis
 * (`w3-tools-admin.md`, `w3-declared-vs-enforced.md`) already flagged a
 * specific asymmetry that needs runtime confirmation, not a blanket claim:
 *   - ALLOWED   — the call succeeds.                                    → ai_tool_calls: +1 row (SUCCEEDED)
 *   - REFUSED   — a permission check returns BEFORE `this.run()` claims  → ai_tool_calls: +0 rows (no trace at all)
 *                 the idempotency ledger row (a pre-ledger authorization refusal).
 *   - FAILED    — the call passes authorization, `this.run()` DOES claim → ai_tool_calls: +1 row (FAILED_PERMANENT)
 *                 a row, and the business logic inside the executor throws.
 *
 * If REFUSED behaved like FAILED (both ledgered), refusal recording would be
 * "as reliable as" success recording, per FR-081. It does not.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';

import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiOrchestratorService } from '../../src/modules/ai-orchestrator/ai-orchestrator.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';

import { User } from '../../src/entities/Auth&RBAC/User';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../../src/entities/Auth&RBAC/RolePermission';
import { Permission } from '../../src/entities/Auth&RBAC/Permission';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';

import { ROLE, ROLE_PERMISSIONS, PERMISSION } from '../../src/rbac/rbac.constants';
import { AI_ADMIN_TOOL } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';

describe('W10 — refusal/failure recorded as reliably as success? (T156)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let orchestrator: AiOrchestratorService;
  let dispatch: AiToolDispatchService;
  let tenantContext: TenantContextService;

  let ownerUserId: string;
  let limitedUserId: string;
  let ownerPrincipal: AuthenticatedUser;
  let limitedPrincipal: AuthenticatedUser;
  let accessSecret: string;

  const convIds: string[] = [];
  interface Row {
    entryPoint: 'dispatcher' | 'REST' | 'WEBSOCKET';
    outcome: 'ALLOWED' | 'REFUSED' | 'FAILED';
    tool: string;
    toolCallRowExists: boolean;
    toolCallStatus: string | null;
    turnRecorded: boolean | 'n/a';
  }
  const results: Row[] = [];

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    orchestrator = harness.app.get(AiOrchestratorService);
    dispatch = harness.app.get(AiToolDispatchService);
    tenantContext = harness.app.get(TenantContextService);
    accessSecret = harness.config.getOrThrow<string>('JWT_ACCESS_SECRET');

    const ds = harness.dataSource;
    const users = ds.getRepository(User);
    const roles = ds.getRepository(Role);
    const userRoles = ds.getRepository(UserRole);
    const rolePermissions = ds.getRepository(RolePermission);
    const permissions = ds.getRepository(Permission);

    // ALLOWED principal — real OWNER role (holds ANALYTICS_DASHBOARD_READ,
    // APPOINTMENTS_CREATE, AND ai.conversations.manage, so it clears BOTH the
    // route guard and the tool-level check).
    const ownerUser = await users.save(
      users.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        email: `w10-refusal-owner-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'W10 Refusal Owner',
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

    // REFUSED-at-tool-level principal — a CUSTOM tenant-scoped role holding
    // ONLY ai.conversations.manage/.read: it clears the REST/WS route guard
    // (@RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE) on
    // ai-orchestrator.controller.ts:67) but has NEITHER
    // analytics.dashboard.read NOR appointments.create — the two tool-level
    // permissions this file exercises. Built this way (rather than reusing an
    // existing role) so the refusal under test is provably the TOOL-LEVEL
    // check, never the route guard rejecting the request before it reaches
    // the orchestrator at all — confirmed by RECEPTIONIST (has
    // appointments.create but not ai.conversations.manage) and DOCTOR (has
    // neither) both being unable to even reach the route in this system.
    const limitedUser = await users.save(
      users.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        email: `w10-refusal-limited-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'W10 Refusal Limited',
        is_active: true,
      }),
    );
    limitedUserId = limitedUser.id;
    const limitedRole = await roles.save(
      roles.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        name: 'W10 AI-chat-only (test fixture)',
        slug: `w10-ai-chat-only-${randomUUID().slice(0, 8)}`,
        description: 'Test-only role: can reach the AI orchestrator route but holds no tool-level permission.',
      }),
    );
    const grantSlugs = [PERMISSION.AI_CONVERSATIONS_MANAGE, PERMISSION.AI_CONVERSATIONS_READ];
    const permRows = await permissions.find({ where: grantSlugs.map((slug) => ({ slug })) });
    if (permRows.length !== grantSlugs.length) {
      throw new Error(`w10-refusal-logging fixture: expected permissions ${grantSlugs.join(', ')} to be seeded.`);
    }
    await rolePermissions.save(
      permRows.map((p) => rolePermissions.create({ role: { id: limitedRole.id } as Role, permission: { id: p.id } as Permission })),
    );
    await userRoles.save(userRoles.create({ user: { id: limitedUser.id } as User, role: { id: limitedRole.id } as Role }));
    limitedPrincipal = {
      id: limitedUser.id,
      tenantId: seed.tenantA.id,
      email: limitedUser.email,
      roles: [limitedRole.slug],
      permissions: grantSlugs,
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
    await q(`DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1 AND slug LIKE 'w10-ai-chat-only-%')`, [seed.tenantA.id]);
    await q(`DELETE FROM user_roles WHERE "userId" IN ($1, $2)`, [ownerUserId, limitedUserId]);
    await q(`DELETE FROM roles WHERE "tenantId" = $1 AND slug LIKE 'w10-ai-chat-only-%'`, [seed.tenantA.id]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [[ownerUserId, limitedUserId]]);

    await teardownAiAuditSeed(ds, seed);
    await harness.close();
  }, 60_000);

  async function toolCallCount(conversationId: string, toolName: string): Promise<number> {
    const rows = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_tool_calls WHERE ai_conversation_id = $1 AND tool_name = $2`,
      [conversationId, toolName],
    );
    return rows[0].c;
  }
  async function toolCallStatus(conversationId: string, toolName: string): Promise<string | null> {
    const rows = await harness.dataSource.query(
      `SELECT status FROM ai_tool_calls WHERE ai_conversation_id = $1 AND tool_name = $2 ORDER BY created_at DESC LIMIT 1`,
      [conversationId, toolName],
    );
    return rows[0]?.status ?? null;
  }
  async function metricsExists(conversationId: string): Promise<boolean> {
    const rows = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_execution_metrics WHERE ai_conversation_id = $1`,
      [conversationId],
    );
    return rows[0].c > 0;
  }

  // ─────────────────────────── (a) the dispatcher, direct ───────────────────────────

  describe('entry point: AiToolDispatchService.execute() called directly', () => {
    it('ALLOWED (owner, get_dashboard_kpis) → 1 ai_tool_calls row, SUCCEEDED', async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      convIds.push(conv.id);
      const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: ownerPrincipal.id, permissions: ownerPrincipal.permissions };
      const result = await dispatch.execute(ctx, { id: randomUUID(), name: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, arguments: '{}' });
      expect(result.success).not.toBe(false);
      const count = await toolCallCount(conv.id, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS);
      expect(count).toBe(1);
      expect(await toolCallStatus(conv.id, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS)).toBe('SUCCEEDED');
      results.push({ entryPoint: 'dispatcher', outcome: 'ALLOWED', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, toolCallRowExists: true, toolCallStatus: 'SUCCEEDED', turnRecorded: 'n/a' });
    });

    it('REFUSED (limited principal, get_dashboard_kpis, no analytics.dashboard.read) → 0 ai_tool_calls rows', async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      convIds.push(conv.id);
      const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: limitedPrincipal.id, permissions: limitedPrincipal.permissions };
      const result = await dispatch.execute(ctx, { id: randomUUID(), name: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, arguments: '{}' });
      expect(result.success).toBe(false);
      const count = await toolCallCount(conv.id, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS);
      expect(count).toBe(0); // the central asymmetry — confirmed at the lowest possible level
      results.push({ entryPoint: 'dispatcher', outcome: 'REFUSED', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, toolCallRowExists: false, toolCallStatus: null, turnRecorded: 'n/a' });
    });

    it('FAILED (owner, get_clinic_details, unknown clinicId) → 1 ai_tool_calls row, FAILED_PERMANENT — the ledger DOES work once run() claims the row', async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      convIds.push(conv.id);
      const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: ownerPrincipal.id, permissions: ownerPrincipal.permissions };
      const result = await dispatch.execute(ctx, {
        id: randomUUID(),
        name: AI_TOOL.GET_CLINIC_DETAILS,
        arguments: JSON.stringify({ clinicId: randomUUID() }), // syntactically valid, does not exist
      });
      expect(result.success).toBe(false);
      const count = await toolCallCount(conv.id, AI_TOOL.GET_CLINIC_DETAILS);
      expect(count).toBe(1);
      const status = await toolCallStatus(conv.id, AI_TOOL.GET_CLINIC_DETAILS);
      expect(['FAILED_PERMANENT', 'UNKNOWN_OUTCOME']).toContain(status);
      results.push({ entryPoint: 'dispatcher', outcome: 'FAILED', tool: AI_TOOL.GET_CLINIC_DETAILS, toolCallRowExists: true, toolCallStatus: status, turnRecorded: 'n/a' });
    });
  });

  // ─────────────────────────────── (b) REST transport ───────────────────────────────

  describe('entry point: POST /api/v1/ai/orchestrator/message (REST)', () => {
    async function driveRest(principal: AuthenticatedUser, toolName: string, args: Record<string, unknown>) {
      const token = await harness.jwt.signAsync(
        { sub: principal.id, tenantId: seed.tenantA.id, type: 'access' },
        { secret: accessSecret, expiresIn: '15m' },
      );
      harness.provider.reset();
      harness.provider.script([{ toolCalls: [scriptedToolCall(toolName, args)] }, { content: 'Scripted REST final answer.' }]);
      const res = await request(harness.app.getHttpServer())
        .post('/api/v1/ai/orchestrator/message')
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: 'DASHBOARD', content: `please ${toolName}`, agentId: seed.tenantA.agentId });
      expect(res.status).toBe(201);
      const convId = res.body.aiConversationId as string;
      convIds.push(convId);
      return convId;
    }

    it('ALLOWED (owner, get_dashboard_kpis) → 1 ai_tool_calls row + 1 ai_execution_metrics row', async () => {
      const convId = await driveRest(ownerPrincipal, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, {});
      expect(await toolCallCount(convId, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS)).toBe(1);
      expect(await toolCallStatus(convId, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS)).toBe('SUCCEEDED');
      expect(await metricsExists(convId)).toBe(true);
      results.push({ entryPoint: 'REST', outcome: 'ALLOWED', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, toolCallRowExists: true, toolCallStatus: 'SUCCEEDED', turnRecorded: true });
    });

    it('REFUSED (limited principal, get_dashboard_kpis) → the ROUTE is reached (route guard passes) but 0 ai_tool_calls rows; the TURN is still recorded (ai_execution_metrics +1)', async () => {
      const convId = await driveRest(limitedPrincipal, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, {});
      expect(await toolCallCount(convId, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS)).toBe(0);
      expect(await metricsExists(convId)).toBe(true); // parity holds at the TURN level...
      const [metric] = await harness.dataSource.query(
        `SELECT tool_calls_count, tool_failure_count, success FROM ai_execution_metrics WHERE ai_conversation_id = $1`,
        [convId],
      );
      expect(metric.tool_calls_count).toBe(1);
      expect(metric.tool_failure_count).toBe(1); // ...but it is an undifferentiated count, not a record
      results.push({ entryPoint: 'REST', outcome: 'REFUSED', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, toolCallRowExists: false, toolCallStatus: null, turnRecorded: true });
    });

    it('ALLOWED (owner, book_appointment) → 1 ai_tool_calls row', async () => {
      const convId = await driveRest(ownerPrincipal, AI_TOOL.BOOK_APPOINTMENT, {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-05-01T10:00:00Z',
        endAt: '2027-05-01T10:30:00Z', // avoids needing a Service row for this narrower repro
      });
      expect(await toolCallCount(convId, AI_TOOL.BOOK_APPOINTMENT)).toBe(1);
      results.push({ entryPoint: 'REST', outcome: 'ALLOWED', tool: AI_TOOL.BOOK_APPOINTMENT, toolCallRowExists: true, toolCallStatus: await toolCallStatus(convId, AI_TOOL.BOOK_APPOINTMENT), turnRecorded: true });
    });

    it('REFUSED (limited principal, book_appointment, no appointments.create) → 0 ai_tool_calls rows', async () => {
      const convId = await driveRest(limitedPrincipal, AI_TOOL.BOOK_APPOINTMENT, {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-05-01T11:00:00Z',
        endAt: '2027-05-01T11:30:00Z',
      });
      expect(await toolCallCount(convId, AI_TOOL.BOOK_APPOINTMENT)).toBe(0);
      results.push({ entryPoint: 'REST', outcome: 'REFUSED', tool: AI_TOOL.BOOK_APPOINTMENT, toolCallRowExists: false, toolCallStatus: null, turnRecorded: true });
    });
  });

  // ─────────────────────────── (c) WebSocket-path transport ─────────────────────────
  //
  // Not a real socket connection — calls the SAME method AiRealtimeGateway.
  // runMessage() calls (HARNESS_GUIDE.md gotcha #8), inside the same
  // TenantContextService.run() + setPrincipal() wrapper the gateway itself
  // uses (ai-realtime.gateway.ts:386-389), so authorization reads the exact
  // same ctx.getUser()/permissions() path a real WS turn would.

  describe('entry point: AiOrchestratorService.handleStream (the /ai gateway\'s own call)', () => {
    async function driveWs(principal: AuthenticatedUser, toolName: string, args: Record<string, unknown>) {
      harness.provider.reset();
      harness.provider.script([{ toolCalls: [scriptedToolCall(toolName, args)] }, { content: 'Scripted WS final answer.' }]);
      const result = await tenantContext.run(async () => {
        tenantContext.setPrincipal(principal);
        return orchestrator.handleStream(
          seed.tenantA.id,
          { channel: 'WEBSITE', content: `please ${toolName}`, agentId: seed.tenantA.agentId },
          () => undefined,
        );
      });
      const convId = (result as { aiConversationId: string }).aiConversationId;
      convIds.push(convId);
      return convId;
    }

    it('ALLOWED (owner, get_dashboard_kpis) → 1 ai_tool_calls row', async () => {
      const convId = await driveWs(ownerPrincipal, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, {});
      expect(await toolCallCount(convId, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS)).toBe(1);
      expect(await metricsExists(convId)).toBe(true);
      results.push({ entryPoint: 'WEBSOCKET', outcome: 'ALLOWED', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, toolCallRowExists: true, toolCallStatus: await toolCallStatus(convId, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS), turnRecorded: true });
    });

    it('REFUSED (limited principal, get_dashboard_kpis) → 0 ai_tool_calls rows — the SAME asymmetry, on the WS path too, not just REST', async () => {
      const convId = await driveWs(limitedPrincipal, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, {});
      expect(await toolCallCount(convId, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS)).toBe(0);
      expect(await metricsExists(convId)).toBe(true);
      results.push({ entryPoint: 'WEBSOCKET', outcome: 'REFUSED', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, toolCallRowExists: false, toolCallStatus: null, turnRecorded: true });
    });
  });

  // ───────────────────── (d) provider failure (turn-level, not tool-level) ─────────────────────
  //
  // A different failure CLASS entirely — the AI provider itself times out /
  // 429s / 5xxs, before any tool is ever proposed. Included so T159's
  // "provider failure" reconstructability dimension has a direct runtime
  // observation, not just a static read of the catch block
  // (ai-execution.service.ts:527-591).

  describe('entry point: provider failure (ScriptedAiProvider.scriptFailure, no tool involved)', () => {
    it('a scripted 5xx provider failure is recorded in ai_execution_metrics (success:false, error_message) and ai_cost_entries (success:false, error_code) — model/tenant/conversation/channel/timestamp all present', async () => {
      const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
      convIds.push(conv.id);
      harness.provider.reset();
      harness.provider.scriptFailure({ kind: '5xx', status: 503 });

      await tenantContext.run(async () => {
        tenantContext.setPrincipal(ownerPrincipal);
        await expect(
          execution.sendMessage(seed.tenantA.id, conv.id, { content: 'trigger a provider failure' }, 'REST'),
        ).rejects.toBeDefined();
      });

      const [metric] = await harness.dataSource.query(
        `SELECT "tenantId", ai_conversation_id, channel, model, success, error_message, created_at
           FROM ai_execution_metrics WHERE ai_conversation_id = $1`,
        [conv.id],
      );
      expect(metric).toBeDefined();
      expect(metric.success).toBe(false);
      expect(metric.error_message).toBeTruthy();
      expect(metric.channel).toBe('REST');
      expect(metric.tenantId).toBe(seed.tenantA.id);
      expect(metric.created_at).toBeTruthy();

      const [costEntry] = await harness.dataSource.query(
        `SELECT success, error_code, tenant_id, ai_conversation_id, created_at
           FROM ai_cost_entries WHERE ai_conversation_id = $1 AND success = false`,
        [conv.id],
      );
      expect(costEntry).toBeDefined();
      expect(costEntry.error_code).toBeTruthy();

      results.push({
        entryPoint: 'dispatcher',
        outcome: 'FAILED',
        tool: '(provider failure — no tool reached)',
        toolCallRowExists: false, // never reaches tool dispatch at all
        toolCallStatus: null,
        turnRecorded: true, // but the TURN itself is fully recorded, with a reason
      });
    });
  });

  it('summary: refusal recording is asymmetric with success recording at EVERY entry point (dispatcher, REST, WS) — turn-level metrics are the only reliably-symmetric record', () => {
    const refused = results.filter((r) => r.outcome === 'REFUSED');
    const allowed = results.filter((r) => r.outcome === 'ALLOWED');
    expect(refused.every((r) => r.toolCallRowExists === false)).toBe(true);
    expect(allowed.every((r) => r.toolCallRowExists === true)).toBe(true);
    // Every REFUSED case that went through a full turn (REST/WS) still shows
    // turn-level recording — the asymmetry is specifically at the PER-CALL
    // ledger, not the existence of a durable record at all.
    expect(refused.filter((r) => r.entryPoint !== 'dispatcher').every((r) => r.turnRecorded === true)).toBe(true);

    process.stdout.write('\n===W10-REFUSAL-LOGGING-SUMMARY-START===\n');
    process.stdout.write(JSON.stringify(results, null, 2));
    process.stdout.write('\n===W10-REFUSAL-LOGGING-SUMMARY-END===\n');
    expect(results.length).toBe(10);
  });
});
