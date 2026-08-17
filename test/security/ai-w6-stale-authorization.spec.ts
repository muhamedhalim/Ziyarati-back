/**
 * T082 — stale authorization on a resumed conversation (FR-030, FR-049; spec
 * edge case 4).
 *
 * `AiToolDispatchService`'s permission gates (e.g. `executeAdminTool`,
 * `ai-tool-dispatch.service.ts:190-201`) read `ctx.permissions`, which
 * `AiExecutionService.sendMessage` populates from `this.ctx.getUser()?.
 * permissions` (`ai-execution.service.ts:344-345`) — i.e. the CURRENT
 * `TenantContextService` store for THIS call, never a value cached on the
 * `AiSession`/conversation row (confirmed by `w6-session-persistence.md` §6:
 * `AiSession` carries no permission/role field at all). This spec proves that
 * property end-to-end rather than reading it: build a real principal via
 * `AuthService.buildAuthenticatedUser` (the same live DB join `JwtStrategy`
 * uses per request), drive turn 1 with a permission GRANTED, revoke the
 * grant in the database between turns, rebuild the principal AGAIN via the
 * same live lookup (simulating the next HTTP request's independent
 * `JwtStrategy.validate`), and drive turn 2 on the SAME conversation —
 * asserting the tool call is refused against the now-current (permission-less)
 * principal, not any state cached from turn 1.
 *
 * [PROMOTED, RTP row 11, AI-008/T067] The task's Verify column asks for "the
 * refusal recorded in ai_tool_calls". `executeAdminTool`
 * (`ai-tool-dispatch.service.ts:190-201`) — and every other permission-gated
 * tool in this dispatcher (`bookAppointment`, `rescheduleAppointment`,
 * `cancelAppointment`) — still returns the Forbidden result BEFORE calling
 * `this.run()`, the claim-side inserter. What changed: each of those gates now
 * also calls `recordAttempt()` on the way out, writing a terminal ATTEMPT row
 * (`attempt:<tool>:<uuid>` key — never the real claim key) before returning.
 * A permission denial therefore now leaves exactly one row in `ai_tool_calls`,
 * closing the audit-completeness gap this file originally found and proved by
 * execution. This spec proves the refusal is real and correctly re-evaluated
 * (the security property that matters), and separately proves — rather than
 * assumes — that it now IS ledgered.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AI_ADMIN_TOOL, AI_ADMIN_TOOL_PERMISSION } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';

describe('AI stale authorization — re-evaluated per turn against the current principal (T082)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let authService: AuthService;
  let ctx: TenantContextService;

  let tempRoleId: string;
  let userRoleId: string;
  let sharedConvId: string;

  const TOOL = AI_ADMIN_TOOL.GET_DASHBOARD_KPIS;
  const REQUIRED_PERMISSION = AI_ADMIN_TOOL_PERMISSION[TOOL];

  beforeAll(async () => {
    expect(REQUIRED_PERMISSION).toBe(PERMISSION.ANALYTICS_DASHBOARD_READ);

    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    authService = harness.app.get(AuthService);
    ctx = harness.app.get(TenantContextService);

    // A dedicated, single-permission tenant-scoped role, granted to the
    // seed's tenantA staff user — created fresh so "revoke between turns" is
    // an isolated, unambiguous DB mutation (deleting exactly this UserRole),
    // never touching the shared system `doctor` role the rest of the seed
    // fixture depends on.
    const permRow = await harness.dataSource.query(`SELECT id FROM permissions WHERE slug = $1`, [
      REQUIRED_PERMISSION,
    ]);
    expect(permRow.length).toBe(1);

    const roles = harness.dataSource.getRepository(Role);
    const tempRole = await roles.save(
      roles.create({
        tenant: { id: seed.tenantA.id } as never,
        name: 'T082 temp dashboard-read role',
        slug: `w6-t082-temp-${seed.tenantA.slug}`,
        is_system: false,
      }),
    );
    tempRoleId = tempRole.id;
    await harness.dataSource.query(
      `INSERT INTO role_permissions("roleId", "permissionId") VALUES ($1, $2)`,
      [tempRoleId, permRow[0].id],
    );

    const userRoles = harness.dataSource.getRepository(UserRole);
    const ur = await userRoles.save(
      userRoles.create({
        user: { id: seed.tenantA.staffUserId } as never,
        role: { id: tempRoleId } as never,
      }),
    );
    userRoleId = ur.id;
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM user_roles WHERE id = $1`, [userRoleId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM role_permissions WHERE "roleId" = $1`, [tempRoleId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM roles WHERE id = $1`, [tempRoleId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('turn 1: principal freshly built from the DB (role granted) — the tool call is ALLOWED, and recorded SUCCEEDED in ai_tool_calls', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});

    const principal1 = await authService.buildAuthenticatedUser(seed.tenantA.staffUserId);
    expect(principal1.permissions).toContain(REQUIRED_PERMISSION);

    harness.provider.reset();
    harness.provider.script([
      { toolCalls: [scriptedToolCall(TOOL, {})] },
      { content: 'Turn 1 scripted follow-up.' },
    ]);

    await ctx.run(async () => {
      ctx.setPrincipal(principal1);
      await execution.sendMessage(
        seed.tenantA.id,
        conv.id,
        { content: 'What are my dashboard KPIs?' },
        'REST',
      );
    });

    const rows = await harness.dataSource.query(
      `SELECT status FROM ai_tool_calls WHERE tenant_id = $1 AND ai_conversation_id = $2 AND tool_name = $3`,
      [seed.tenantA.id, conv.id, TOOL],
    );
    expect(rows.some((r: { status: string }) => r.status === 'SUCCEEDED')).toBe(true);

    sharedConvId = conv.id;

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE tenant_id = $1 AND ai_conversation_id = $2`, [
      seed.tenantA.id,
      conv.id,
    ]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
  });

  it('revocation: the role is unassigned in the database (not merely a variable in this test)', async () => {
    const before = await harness.dataSource.query(`SELECT 1 FROM user_roles WHERE id = $1`, [userRoleId]);
    expect(before.length).toBe(1);

    await harness.dataSource.query(`DELETE FROM user_roles WHERE id = $1`, [userRoleId]);

    const after = await harness.dataSource.query(`SELECT 1 FROM user_roles WHERE id = $1`, [userRoleId]);
    expect(after.length).toBe(0);
  });

  it('turn 2, SAME conversation: principal REBUILT from the DB (fresh lookup, simulating the next request) no longer carries the permission — the tool call is REFUSED against the CURRENT principal', async () => {
    const principal2 = await authService.buildAuthenticatedUser(seed.tenantA.staffUserId);
    expect(principal2.permissions).not.toContain(REQUIRED_PERMISSION);

    harness.provider.reset();
    harness.provider.script([
      { toolCalls: [scriptedToolCall(TOOL, {})] },
      { content: 'Turn 2 scripted follow-up.' },
    ]);

    let toolResultSeenByModel: string | undefined;
    await ctx.run(async () => {
      ctx.setPrincipal(principal2);
      await execution.sendMessage(
        seed.tenantA.id,
        sharedConvId,
        { content: 'What are my dashboard KPIs?' },
        'REST',
      );
    });

    // The tool result actually fed back to the model on the SAME turn proves
    // the refusal, independent of the ai_tool_calls ledger gap noted below.
    const secondCallMessages = harness.provider.capturedMessages(1);
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
    toolResultSeenByModel = typeof toolMsg?.content === 'string' ? toolMsg.content : undefined;
    expect(toolResultSeenByModel).toBeDefined();
    expect(toolResultSeenByModel).toMatch(/forbidden/i);
    expect(toolResultSeenByModel).toContain(REQUIRED_PERMISSION);

    // [PROMOTED, RTP row 11, AI-008/T067] confirmed, not assumed: the
    // permission-denied attempt on turn 2 now writes exactly one ATTEMPT row
    // via recordAttempt() — the dispatcher's permission gate still returns
    // before ever calling run() (the claim-side inserter), but no longer
    // leaves the denial unledgered.
    const rows = await harness.dataSource.query(
      `SELECT status, idempotency_key FROM ai_tool_calls WHERE tenant_id = $1 AND ai_conversation_id = $2 AND tool_name = $3`,
      [seed.tenantA.id, sharedConvId, TOOL],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('DENIED');
    expect(rows[0].idempotency_key).toMatch(new RegExp(`^attempt:${TOOL}:[0-9a-f-]{36}$`));

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [sharedConvId]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [sharedConvId]);
  });
});
