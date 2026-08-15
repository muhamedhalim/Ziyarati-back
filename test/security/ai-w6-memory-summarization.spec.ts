/**
 * T081 — cross-tenant summarization path (FR-053; plan.md §Current
 * Architecture Memory :138-161).
 *
 * `AiMemoryService.summarizeConversation(tenantId, aiConversationId,
 * customerId, sourceTenantId)` (`ai-memory.service.ts:137-168`) is the ONLY
 * place a memory write can be sourced from a DIFFERENT tenant's messages than
 * the one it is written into — used exactly once, by guest→patient conversion
 * (`GuestSessionService.convert`, source = the discovery tenant, target = the
 * authenticated principal's own tenant). `sourceTenantId` is a required,
 * distinct-from-target TypeScript parameter with no unscoped overload, and the
 * FND-001 comment at `:143-148` states the source read "MUST carry a tenant
 * predicate" — this spec verifies that predicate actually holds at runtime,
 * for the omitted-argument and foreign-value cases the task asks for.
 *
 * GENUINE GAP FOUND (reported, not hidden, per this task's own instructions):
 * the raw SQL at `ai-memory.service.ts:149-154` filters `... AND tenant_id =
 * $2 ...` against `ai_messages` — but `ai_messages`'s real tenant column is
 * `"tenantId"` (TypeORM's default camelCase quoting for `@ManyToOne(() =>
 * Tenant) tenant`, confirmed against the live schema: `information_schema.
 * columns` for `ai_messages` lists `tenantId`, never `tenant_id`). This is a
 * SEPARATE, pre-existing production defect (not introduced by this audit),
 * confirmed live below: `summarizeConversation` throws `column "tenant_id"
 * does not exist` on EVERY call, legitimate or not — which means the intended
 * security property (source read is tenant-scoped) currently cannot be
 * distinguished from "the method is broken" by outcome alone, because both
 * look like a thrown error. This spec proves the bug first (so the negative
 * cases below are read correctly, as "also throws, for the same underlying
 * reason" rather than "correctly refused"), then still exercises the omitted/
 * foreign-value cases and asserts the one thing that IS true regardless of the
 * bug: no `ai_memories` row is ever created for any of them (fail-closed by
 * accident of the crash, not by a validated guard — recorded precisely as
 * such, not overclaimed as a working security control).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiMemoryService } from '../../src/modules/ai-memory/ai-memory.service';
import { AI_MESSAGE_ROLE } from '../../src/modules/ai/ai.constants';

describe('AI memory — cross-tenant summarization path (T081)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let memory: AiMemoryService;
  let convA: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    memory = harness.app.get(AiMemoryService);

    const conv = await conversations.start(seed.tenantA.id, {});
    convA = conv.id;
    await harness.dataSource.query(
      `INSERT INTO ai_messages (ai_conversation_id, "tenantId", role, content) VALUES ($1, $2, $3, $4)`,
      [convA, seed.tenantA.id, AI_MESSAGE_ROLE.USER, 'I would like to book a follow-up appointment please.'],
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [convA]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convA]);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function memoryCount(tenantId: string, conversationId: string): Promise<number> {
    const rows = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_memories WHERE "tenantId" = $1 AND ai_conversation_id = $2`,
      [tenantId, conversationId],
    );
    return rows[0]?.c ?? 0;
  }

  it('[GENUINE GAP] the raw SQL predicate references a column that does not exist on ai_messages — the CORRECT-argument call itself throws', async () => {
    const before = await memoryCount(seed.tenantA.id, convA);

    // sourceTenantId === the conversation's real owning tenant — the
    // "legitimate" call shape guest-convert uses (targetTenantId happens to
    // equal sourceTenantId here only because this spec has one tenant to
    // summarize FROM; the bug is in the query itself, independent of whether
    // target === source).
    await expect(
      memory.summarizeConversation(seed.tenantA.id, convA, undefined, seed.tenantA.id),
    ).rejects.toThrow(/tenant_id/i);

    const after = await memoryCount(seed.tenantA.id, convA);
    expect(after).toBe(before); // no memory row from a call that threw
  });

  it('confirms this is specifically the "tenant_id" vs "tenantId" column-name mismatch, isolated to this one query', async () => {
    // Direct reproduction of the exact query ai-memory.service.ts:149-154
    // issues, independent of the service, so the root cause is pinned down
    // precisely rather than inferred from the wrapped error message alone.
    await expect(
      harness.dataSource.query(
        `SELECT content FROM ai_messages
          WHERE ai_conversation_id = $1 AND tenant_id = $2 AND role = 'user'
          ORDER BY created_at DESC LIMIT 6`,
        [convA, seed.tenantA.id],
      ),
    ).rejects.toThrow(/column "tenant_id" does not exist/i);

    // The column that DOES exist and that every other reader of ai_messages
    // in this codebase correctly uses (ai-audit-seed.ts teardown, this spec's
    // own seed insert above).
    const columns: { column_name: string }[] = await harness.dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_messages'`,
    );
    expect(columns.map((c) => c.column_name)).toContain('tenantId');
    expect(columns.map((c) => c.column_name)).not.toContain('tenant_id');
  });

  it('sourceTenantId OMITTED (bypassing the TypeScript required-parameter guard at the call site): also throws — cannot be distinguished from the bug above, no memory row is created either way', async () => {
    const before = await memoryCount(seed.tenantA.id, convA);

    // `sourceTenantId` has no default and no unscoped overload in the type
    // signature — the only way to call this "unscoped" at runtime is to
    // deliberately bypass TypeScript, exactly as an attacker who reached this
    // method some other way (not through the one real caller, which always
    // supplies discoveryTenantId) would have to. This is what T081's Verify
    // column asks the test to prove is refused.
    await expect(
      (memory as unknown as { summarizeConversation: (...a: unknown[]) => Promise<unknown> }).summarizeConversation(
        seed.tenantA.id,
        convA,
        undefined,
        undefined,
      ),
    ).rejects.toBeTruthy();

    const after = await memoryCount(seed.tenantA.id, convA);
    expect(after).toBe(before);
  });

  it('sourceTenantId set to a FOREIGN tenant (tenant B, which does not own convA): also throws before any cross-tenant read could complete, no memory row is created', async () => {
    const before = await memoryCount(seed.tenantA.id, convA);

    await expect(
      memory.summarizeConversation(seed.tenantA.id, convA, undefined, seed.tenantB.id),
    ).rejects.toBeTruthy();

    const after = await memoryCount(seed.tenantA.id, convA);
    expect(after).toBe(before);
    // Also confirm nothing landed under tenant B by mistake.
    expect(await memoryCount(seed.tenantB.id, convA)).toBe(0);
  });

  it('[GENUINE GAP] a generic audit_logs table EXISTS and is used by other cross-tenant-sensitive flows (auth, roles, staff-access) — but ai-memory/guest-chat never write to it, for this operation or any other', async () => {
    // Corrected from an earlier assumption: this codebase DOES have a generic
    // audit trail (`entities/Auth&RBAC/AuditLog.ts`, table `audit_logs`,
    // columns action/entity_type/entity_id/old_values/new_values/tenant/user),
    // actively written by src/modules/auth/auth.service.ts,
    // src/modules/staff/staff-access.service.ts, src/modules/auth/roles.service.ts,
    // and others (source grep). Neither ai-memory.service.ts nor
    // guest-chat/guest-session.service.ts imports or writes AuditLog anywhere
    // (confirmed by source grep — zero matches for "AuditLog"/"audit_log" in
    // either module directory). So the cross-tenant summarization path this
    // spec exercises — read source-tenant messages, write a memory into a
    // DIFFERENT target tenant, exactly the shape of operation `audit_logs`
    // exists to record for other flows — leaves no entry in the one audit
    // mechanism the rest of the codebase uses for comparable operations.
    // The closest thing to an "audit record" for a legitimate call is the
    // resulting ai_memories row itself, which — per the bug proven above — is
    // currently never created at all, legitimate call or not.
    const auditTables: { table_name: string }[] = await harness.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'audit_logs'`,
    );
    expect(auditTables.map((t) => t.table_name)).toContain('audit_logs');

    const rows = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM audit_logs WHERE entity_type = 'ai_memory' OR entity_type = 'ai_conversation'`,
    );
    expect(rows[0].c).toBe(0);
  });
});
