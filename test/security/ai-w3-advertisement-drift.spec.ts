/**
 * T093 — advertisement-versus-enforcement drift, for every principal type.
 *
 * Two INDEPENDENT observations per principal, both real executions:
 *  - ADVERTISED: drives one real turn through `AiExecutionService.sendMessage`
 *    (the real `availableTools()` filter, `ai-execution.service.ts:1320-1350`)
 *    under `TenantContextService.run()` with the principal set, and reads
 *    `harness.provider.capturedRequests[0].tools` at the provider boundary —
 *    exactly what the "model" would have been offered.
 *  - ENFORCED: executes ALL 26 tools through the REAL dispatcher
 *    (`AiToolDispatchService.execute`, the same entry point T088/T089/T090
 *    already proved this mechanism against) for the SAME principal, and
 *    records which are NOT authorization-blocked (same `auth_blocked`
 *    classification as T089).
 *
 * The diff is the finding: `w3-advertisement.md` (T046) predicted no live
 * mismatch today (every admin tool has a map entry; unmapped booking tools
 * are intentionally open), but flagged a structural default-open/default-closed
 * asymmetry as a LATENT risk. This file confirms the CURRENT state by
 * execution, for the record, and leaves the structural risk to
 * `evidence/raw/candidates-w3.md` (T104).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import {
  ALL_TOOLS,
  ALL_PRINCIPAL_TYPES,
  PrincipalType,
  permissionsForPrincipal,
  sampleArgsFor,
  classifyRefusal,
} from './fixtures/ai-w3-tool-catalog';

describe('W3 — advertisement-vs-enforcement drift, all 8 principal types (T093)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let execution: AiExecutionService;
  let dispatch: AiToolDispatchService;
  let tenantContext: TenantContextService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
    execution = harness.app.get(AiExecutionService);
    dispatch = harness.app.get(AiToolDispatchService);
    tenantContext = harness.app.get(TenantContextService);

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

  function principalFor(type: PrincipalType): { tenantId: string; user: AuthenticatedUser } {
    if (type === 'guest') {
      return { tenantId: seed.discoveryTenantId, user: seed.guestA };
    }
    return {
      tenantId: seed.tenantA.id,
      user: {
        id: type === 'ai-bot' ? 'synthetic-ai-bot' : seed.tenantA.staffUserId,
        tenantId: seed.tenantA.id,
        roles: [type],
        permissions: permissionsForPrincipal(type),
        guest: false,
      },
    };
  }

  /** ADVERTISED: real turn, real `availableTools()`, captured at the provider boundary. */
  async function advertisedSet(type: PrincipalType): Promise<string[]> {
    const { tenantId, user } = principalFor(type);
    const conv = await conversations.start(tenantId, {});
    if (type === 'guest') {
      await sessions.patch(tenantId, conv.id, { guestSubject: user.id });
    }
    harness.provider.reset();
    harness.provider.script([{ content: `scripted ack for ${type}` }]);

    await tenantContext.run(async () => {
      tenantContext.setPrincipal(user);
      await execution.sendMessage(tenantId, conv.id, { content: 'what can you help with?' }, 'REST');
    });

    const tools = harness.provider.capturedRequests[0]?.tools ?? [];
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    return tools.map((t) => t.name).sort();
  }

  /** ENFORCED: real dispatcher execution of ALL 26 tools for this principal. */
  async function enforcedSet(type: PrincipalType): Promise<string[]> {
    const { tenantId, user } = principalFor(type);
    const reachable: string[] = [];

    for (const tool of ALL_TOOLS) {
      const conv = await conversations.start(tenantId, {});
      if (type === 'guest') {
        await sessions.patch(tenantId, conv.id, { guestSubject: user.id });
      }
      const ctx: ToolContext = {
        tenantId,
        aiConversationId: conv.id,
        permissions: user.permissions,
        actorUserId: type === 'guest' ? undefined : user.id,
        principal: type === 'guest' ? user : undefined,
      };
      const result = await dispatch.execute(ctx, scriptedToolCall(tool.name, sampleArgsFor(tool.name, seed)));
      const cls = result.success === false ? classifyRefusal(typeof result.error === 'string' ? result.error : undefined) : { bucket: 'other_refusal' as const };
      if (cls.bucket !== 'auth_blocked') reachable.push(tool.name);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    }
    return reachable.sort();
  }

  const drift: Record<string, { advertised: string[]; enforced: string[]; advertisedNotEnforced: string[]; enforcedNotAdvertised: string[] }> = {};

  it('computes advertised vs enforced sets for all 8 principal types and reports the drift table', async () => {
    for (const type of ALL_PRINCIPAL_TYPES) {
      const advertised = await advertisedSet(type);
      const enforced = await enforcedSet(type);
      const advertisedNotEnforced = advertised.filter((n) => !enforced.includes(n));
      const enforcedNotAdvertised = enforced.filter((n) => !advertised.includes(n));
      drift[type] = { advertised, enforced, advertisedNotEnforced, enforcedNotAdvertised };
    }

    // eslint-disable-next-line no-console
    console.log('\n===T093-ADVERTISEMENT-DRIFT-START===\n' + JSON.stringify(drift, null, 2) + '\n===T093-ADVERTISEMENT-DRIFT-END===\n');
  }, 120_000);

  it('NO tool is ever advertised to a principal who is then authorization-blocked from it (no false advertisement, for any of the 8 principal types)', () => {
    for (const type of ALL_PRINCIPAL_TYPES) {
      expect(drift[type].advertisedNotEnforced).toEqual([]);
    }
  });

  it('the guest ENFORCED set no longer exceeds the guest ADVERTISED set — AI-020/PD-2 narrowed the dispatcher, closing the gap this file previously recorded as a drift finding', () => {
    // AI-020/PD-2 (2026-08-17): the dispatcher now refuses `check_availability`
    // and `get_customer_insurance_status` for any principal with no acting
    // user (guests) — both sets, computed from the SAME running system as
    // before (no hand-maintained list on either side), are now identical for
    // the guest principal type. Non-guest principal types are unaffected —
    // both tools remain legitimately reachable by staff regardless of
    // whether they happen to be advertised to a given staff role, which is
    // not the gap AI-020 was about.
    expect(drift.guest.enforcedNotAdvertised).toEqual([]);
  });
});
