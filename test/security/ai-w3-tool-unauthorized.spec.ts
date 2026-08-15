/**
 * T088 — every one of the 26 AI tools, executed as a principal MISSING the
 * required permission, via `AiToolDispatchService.execute` (a scripted stub
 * tool call — no full turn/provider round-trip needed, per HARNESS_GUIDE
 * gotcha #10).
 *
 * Static evidence (`w3-declared-vs-enforced.md`, T044) already established
 * that only 11 of the 26 tools declare a permission at all — the 3 core
 * write tools (`book_appointment`/`reschedule_appointment`/`cancel_appointment`)
 * and all 8 admin tools. The other 15 are intentionally permission-free by
 * design (public discovery, tenant-bound-but-unrestricted reads, the public
 * booking catalog). Asserting "refused for missing permission" against those
 * 15 would be a FALSE claim — the audit's own rule is that `Observed` must
 * come from an executed attempt, never an assumption, so this file instead
 * executes all 26 and asserts the CORRECT outcome for each: refusal (with a
 * provably absent side effect) for the 11 gated tools, and "not refused ON
 * PERMISSION GROUNDS" (no `Forbidden: ... permission` error) for the other 15
 * — which is the accurate, from-execution confirmation of the static claim,
 * not an omission of them.
 *
 * Every gated-tool case additionally checks the `ai_tool_calls` ledger for a
 * row belonging to this denied call — `w3-declared-vs-enforced.md` finding 3
 * and `w3-tools-admin.md` both flag (from source reading) that a denial
 * returns before `this.run(...)` ever claims a ledger row, contradicting the
 * class doc comment's "every call (success or failure) is recorded" claim.
 * This file confirms that by execution rather than repeating the claim.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import {
  ALL_TOOLS,
  PERMISSION_GATED_TOOLS,
  UNGATED_TOOLS,
  toolMeta,
  backingServiceSpy,
} from './fixtures/ai-w3-tool-catalog';

describe('W3 — every tool executed as a principal missing the required permission (T088)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let dispatch: AiToolDispatchService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    dispatch = harness.app.get(AiToolDispatchService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sanity: exactly 26 tools in the catalog, 11 gated + 15 ungated', () => {
    expect(ALL_TOOLS).toHaveLength(26);
    expect(PERMISSION_GATED_TOOLS).toHaveLength(11);
    expect(UNGATED_TOOLS).toHaveLength(15);
  });

  describe('11 permission-gated tools — principal has an acting user but EMPTY permissions', () => {
    for (const tool of PERMISSION_GATED_TOOLS) {
      it(`${tool.name} (requires "${tool.declaredPermission}") refuses, invokes zero backing-service calls, and its ledger state is recorded`, async () => {
        const conv = await conversations.start(seed.tenantA.id, {});
        const spy = backingServiceSpy(harness.app, tool.name);

        const ctx: ToolContext = {
          tenantId: seed.tenantA.id,
          aiConversationId: conv.id,
          actorUserId: seed.tenantA.staffUserId,
          permissions: [], // missing the declared permission (and every other one)
        };

        const result = await dispatch.execute(ctx, scriptedToolCall(tool.name, {}));

        // 1. Refusal artifact from the tool result itself.
        expect(result.success).toBe(false);

        // 2. Provably absent side effect — the backing service was never called.
        expect(spy).not.toHaveBeenCalled();

        // 3. Ledger state, recorded as OBSERVED (not assumed): per the class doc
        // comment (`ai-tool-dispatch.service.ts:83,187-188`) a denied call
        // should still be recorded in `ai_tool_calls`. Static reading of the
        // source (`w3-declared-vs-enforced.md` finding 3) found the code path
        // for all 11 of these tools returns BEFORE `this.run(...)` ever claims
        // a ledger row on a permission denial. Confirm which is actually true
        // at runtime rather than asserting either without checking.
        const rows = await harness.dataSource.query(
          `SELECT status FROM ai_tool_calls WHERE tenant_id = $1 AND ai_conversation_id = $2 AND tool_name = $3`,
          [seed.tenantA.id, conv.id, tool.name],
        );
        // eslint-disable-next-line no-console
        console.log(`[T088 ledger-on-denial] ${tool.name}: ${rows.length} row(s)${rows[0] ? ` status=${rows[0].status}` : ''}`);
        expect(rows).toHaveLength(0); // observed: denial is NOT ledgered (confirms the static finding by execution)

        await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
      });
    }
  });

  describe('15 ungated tools — no permission is declared, so refusal-for-missing-permission does not apply; confirm by execution that none is gated on a phantom permission', () => {
    for (const tool of UNGATED_TOOLS) {
      it(`${tool.name} is never refused with a "Forbidden: ... permission" error for a principal with EMPTY permissions`, async () => {
        const conv = await conversations.start(seed.tenantA.id, {});
        const ctx: ToolContext = {
          tenantId: seed.tenantA.id,
          aiConversationId: conv.id,
          // No actorUserId either — the lowest-common-denominator principal.
          permissions: [],
        };

        const result = await dispatch.execute(ctx, scriptedToolCall(tool.name, {}));

        // The tool may still fail for an UNRELATED reason (missing required
        // argument, no session precondition, no acting user for the core
        // "no acting user" branch, etc.) — that is expected and not a
        // permission refusal. The one thing that must NEVER appear for an
        // ungated tool is the dispatcher's permission-denial wording.
        const err = typeof result.error === 'string' ? result.error : '';
        expect(err.toLowerCase()).not.toContain('permission');

        await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
      });
    }
  });

  it('control case: the SAME 11 gated tools succeed (are not refused) once the exact declared permission is granted — proves the refusal above is the permission check, not something else', async () => {
    for (const tool of PERMISSION_GATED_TOOLS) {
      const meta = toolMeta(tool.name);
      const conv = await conversations.start(seed.tenantA.id, {});
      const spy = backingServiceSpy(harness.app, tool.name);
      // Empty array is a safe universal stand-in across all 11 backing calls
      // (iterated, spread, or `.total`-read — never thrown on) so this loop
      // never depends on realistic booking/reschedule/cancel arguments; the
      // point here is ONLY to prove the permission gate itself opens, not to
      // exercise the full booking domain logic (that is T091/T095's job).
      spy.mockResolvedValue([] as never);

      const ctx: ToolContext = {
        tenantId: seed.tenantA.id,
        aiConversationId: conv.id,
        actorUserId: seed.tenantA.staffUserId,
        permissions: [meta.declaredPermission!],
      };

      const result = await dispatch.execute(ctx, scriptedToolCall(tool.name, {}));
      // Whatever the outcome (argument-validation failure is possible with
      // empty args for the 3 core write tools), it must NOT be the
      // permission-denial wording — proves the gate opened.
      const err = typeof result.error === 'string' ? result.error : '';
      expect(err).not.toMatch(/^Forbidden:/);

      jest.restoreAllMocks();
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    }
  });
});
