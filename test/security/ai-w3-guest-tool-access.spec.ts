/**
 * T089 — every permission-gated tool executed as a GUEST principal
 * (`permissions: []`, no `actorUserId`), enumerating exactly which of the 26
 * tools a guest can reach through `AiToolDispatchService.execute` directly —
 * not through the advertised-tools filter (`AiExecutionService.availableTools()`,
 * `w3-advertisement.md`/T046), which only controls what is OFFERED to the
 * model, never what the dispatcher will actually run if a tool_call with that
 * name arrives (a compromised/malicious client can emit any tool name it
 * likes; the dispatcher's `switch` matches on name alone).
 *
 * The task's Verify clause: "assert the reachable set matches the
 * public-booking catalog and nothing more." This file checks that claim by
 * EXECUTION rather than assuming it — and the static evidence
 * (`w3-declared-vs-enforced.md`) already flags that `check_availability` and
 * `get_customer_insurance_status` are tenant-bound but carry no permission
 * gate either, so they are candidates for being DISPATCHER-reachable by a
 * guest despite not being part of the advertised public-booking catalog
 * (`PUBLIC_DISCOVERY_TOOL_NAMES` + `AI_PUBLIC_BOOKING_TOOLS`, 13 tools). This
 * file's job is to confirm or refute that by direct execution.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import {
  AI_PUBLIC_BOOKING_TOOLS,
  PUBLIC_DISCOVERY_TOOL_NAMES,
} from '../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { ALL_TOOLS, PERMISSION_GATED_TOOLS, sampleArgsFor, classifyRefusal } from './fixtures/ai-w3-tool-catalog';

const argsFor = sampleArgsFor;
const classify = classifyRefusal;

describe('W3 — every tool executed as a GUEST principal, reachable-set enumeration (T089)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let dispatch: AiToolDispatchService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
    dispatch = harness.app.get(AiToolDispatchService);

    // Public-booking preconditions (HARNESS_GUIDE gotcha #3) — opt tenant A in
    // so the public-booking tools reach real business logic instead of
    // uniformly failing on "not publicly bookable" before ever exercising
    // their own validation.
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

  /** One guest conversation, properly ownership-bound per HARNESS_GUIDE gotcha #2. */
  async function guestConversation() {
    const conv = await conversations.start(seed.discoveryTenantId, {});
    await sessions.patch(seed.discoveryTenantId, conv.id, { guestSubject: seed.guestA.id });
    return conv;
  }

  const observed: Record<string, { bucket: 'auth_blocked' | 'other_refusal'; reason?: 'no_acting_user' | 'permission'; success: boolean; error?: string }> = {};

  it('executes all 26 tools as guest and classifies each outcome', async () => {
    for (const tool of ALL_TOOLS) {
      const conv = await guestConversation();
      const ctx: ToolContext = {
        tenantId: seed.discoveryTenantId,
        aiConversationId: conv.id,
        principal: seed.guestA,
        permissions: [], // guest grants nothing
        // no actorUserId — guest has none
      };
      const result = await dispatch.execute(ctx, scriptedToolCall(tool.name, argsFor(tool.name, seed)));
      const err = typeof result.error === 'string' ? result.error : undefined;
      const success = result.success !== false;
      const cls = success ? { bucket: 'other_refusal' as const, reason: undefined } : classify(err);
      observed[tool.name] = { bucket: success ? 'other_refusal' : cls.bucket, reason: cls.reason, success, error: err };
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    }

    // eslint-disable-next-line no-console
    console.log('\n===T089-GUEST-REACHABILITY-START===\n' + JSON.stringify(observed, null, 2) + '\n===T089-GUEST-REACHABILITY-END===\n');

    // 1. Every one of the 11 permission-gated tools is authorization-blocked
    // for a guest — but NOT always via the same gate. The 8 admin tools hit
    // the permission check directly; the 3 core write tools hit the EARLIER
    // "no acting user" precondition first (a guest has no acting user at
    // all), so the permission check is never reached for them. Both are
    // genuine, distinct, observed authorization gates — recorded precisely.
    for (const tool of PERMISSION_GATED_TOOLS) {
      expect(observed[tool.name].success).toBe(false);
      expect(observed[tool.name].bucket).toBe('auth_blocked');
    }
    const coreWriteTools = [AI_TOOL.BOOK_APPOINTMENT, AI_TOOL.RESCHEDULE_APPOINTMENT, AI_TOOL.CANCEL_APPOINTMENT];
    for (const name of coreWriteTools) {
      expect(observed[name].reason).toBe('no_acting_user');
    }
    const adminToolNames = PERMISSION_GATED_TOOLS.filter((t) => t.catalog === 'admin').map((t) => t.name);
    for (const name of adminToolNames) {
      expect(observed[name].reason).toBe('permission');
    }

    // 2. None of the 15 ungated tools is ever authorization-blocked — they
    // either succeed or fail for an unrelated (business/session) reason.
    for (const tool of ALL_TOOLS) {
      if (tool.declaredPermission === null) {
        expect(observed[tool.name].bucket).not.toBe('auth_blocked');
      }
    }
  }, 30_000);

  it('the DISPATCHER-reachable set (not authorization-blocked) is a SUPERSET of the ADVERTISED guest catalog, not identical to it — reports the exact delta', () => {
    const advertisedGuestSet = new Set<string>([...PUBLIC_DISCOVERY_TOOL_NAMES, ...AI_PUBLIC_BOOKING_TOOLS.map((t) => t.name)]);
    expect(advertisedGuestSet.size).toBe(13); // 4 reused discovery/handover + 9 public-only, per w3-advertisement.md

    const dispatcherReachable = new Set(
      Object.entries(observed)
        .filter(([, v]) => v.bucket !== 'auth_blocked')
        .map(([name]) => name),
    );

    const extraBeyondAdvertised = [...dispatcherReachable].filter((n) => !advertisedGuestSet.has(n)).sort();
    const advertisedButNotReachable = [...advertisedGuestSet].filter((n) => !dispatcherReachable.has(n)).sort();

    // eslint-disable-next-line no-console
    console.log(
      '\n===T089-ADVERTISED-VS-DISPATCHER-DELTA===\n' +
        JSON.stringify({ advertisedGuestSet: [...advertisedGuestSet].sort(), dispatcherReachable: [...dispatcherReachable].sort(), extraBeyondAdvertised, advertisedButNotReachable }, null, 2) +
        '\n===END===\n',
    );

    // Everything ADVERTISED to a guest must also be DISPATCHER-reachable (no
    // false advertisement — the tool inventory promises nothing the dispatcher
    // then blocks for the same principal).
    expect(advertisedButNotReachable).toEqual([]);

    // The dispatcher-reachable set is NOT confined to the advertised catalog:
    // `check_availability` and `get_customer_insurance_status` are tenant-bound
    // but carry no permission gate, so a raw tool_call naming either one
    // (bypassing the model/advertisement layer entirely) reaches real business
    // logic for a guest — confirming, by execution, the static finding flagged
    // in w3-declared-vs-enforced.md. This is recorded as an observed fact, not
    // silently treated as a pass — see evidence/raw/candidates-w3.md (T104).
    expect(extraBeyondAdvertised.sort()).toEqual([AI_TOOL.CHECK_AVAILABILITY, AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS].sort());
  });
});
