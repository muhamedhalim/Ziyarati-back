/**
 * T077 — cross-user memory recall within ONE tenant (FR-048).
 *
 * `AiMemory` (`src/entities/AI Agent/AiMemory.ts`) carries exactly three scoping
 * dimensions: `tenant` (FK), `customer_id` (nullable plain uuid — the patient
 * linkage), and `ai_conversation_id` (nullable plain uuid — origin
 * conversation, NOT used as a recall filter, see the dedicated test below).
 * There is no `user_id`/`created_by`/role/session column anywhere on this
 * entity or its pgvector sidecar (`ai_memory_embeddings`). This spec therefore
 * tests the scoping dimensions that actually exist in the schema, and records —
 * rather than assumes — which of FR-048's named dimensions (user, role,
 * session, conversation) map onto something real:
 *
 *  - "user" isolation → `customer_id` scoping (the closest real analogue: the
 *    patient/customer a memory is linked to).
 *  - "conversation" scoping → NOT implemented as a recall filter at all
 *    (`ai_conversation_id` is stored but never referenced in `recall()`'s
 *    query — verified below, not merely read from source). This is recorded
 *    as an assessment finding (§ below), not silently assumed away.
 *  - "role"/"session" → no corresponding column exists; recorded as
 *    Not Applicable to this data model, not silently skipped.
 *
 * The seed's `tenantA.customerIds` (T015, `seedAiAudit`) supplies two real,
 * distinct customer ids within ONE tenant — exactly the "known seed ownership"
 * T077's Verify column asks for.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiMemoryService } from '../../src/modules/ai-memory/ai-memory.service';

describe('AI memory — cross-user (cross-customer) recall isolation within one tenant (T077)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let memory: AiMemoryService;

  let customer1: string;
  let customer2: string;

  const CUSTOMER1_FACT = 'Customer-1-only: allergic to penicillin, prefers evening slots';
  const CUSTOMER2_FACT = 'Customer-2-only: prefers Dr. Amara, pays by insurance claim #77213';
  const TENANT_WIDE_FACT = 'Tenant-wide fact: clinic closes early on Fridays';

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    memory = harness.app.get(AiMemoryService);
    [customer1, customer2] = seed.tenantA.customerIds;
    expect(customer1).toBeTruthy();
    expect(customer2).toBeTruthy();
    expect(customer1).not.toBe(customer2);

    await memory.remember(seed.tenantA.id, {
      type: 'preference',
      content: CUSTOMER1_FACT,
      customerId: customer1,
      importance: 5,
    });
    await memory.remember(seed.tenantA.id, {
      type: 'preference',
      content: CUSTOMER2_FACT,
      customerId: customer2,
      importance: 5,
    });
    await memory.remember(seed.tenantA.id, {
      type: 'faq',
      content: TENANT_WIDE_FACT,
      importance: 3,
      // no customerId — tenant-wide/shared memory
    });
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  // Keyword-fallback recall (default non-pgvector harness) matches on literal
  // substring overlap with the query terms — this string deliberately
  // contains a literal token unique to each of the three planted facts
  // (penicillin → customer 1, amara/insurance → customer 2, friday → tenant-
  // wide) so every candidate a given customerId scope legitimately admits is
  // actually retrievable, regardless of which customer is querying.
  const SHARED_QUERY = 'penicillin amara insurance friday closing hours';

  it('recalling for customer 1 returns customer-1 content and tenant-wide content, never customer-2 content', async () => {
    const result = await memory.recall(seed.tenantA.id, {
      query: SHARED_QUERY,
      customerId: customer1,
      limit: 10,
    });
    const contents = result.map((m) => m.content);
    expect(contents).toContain(CUSTOMER1_FACT);
    expect(contents).toContain(TENANT_WIDE_FACT);
    expect(contents).not.toContain(CUSTOMER2_FACT);
    expect(result.every((m) => m.customerId === customer1 || m.customerId === null)).toBe(true);
  });

  it('recalling for customer 2 returns customer-2 content and tenant-wide content, never customer-1 content', async () => {
    const result = await memory.recall(seed.tenantA.id, {
      query: SHARED_QUERY,
      customerId: customer2,
      limit: 10,
    });
    const contents = result.map((m) => m.content);
    expect(contents).toContain(CUSTOMER2_FACT);
    expect(contents).toContain(TENANT_WIDE_FACT);
    expect(contents).not.toContain(CUSTOMER1_FACT);
    expect(result.every((m) => m.customerId === customer2 || m.customerId === null)).toBe(true);
  });

  it('recalling with NO customerId returns only tenant-wide (unowned) content, never either customer\'s private memory', async () => {
    const result = await memory.recall(seed.tenantA.id, {
      query: SHARED_QUERY,
      limit: 10,
    });
    const contents = result.map((m) => m.content);
    expect(contents).toContain(TENANT_WIDE_FACT);
    expect(contents).not.toContain(CUSTOMER1_FACT);
    expect(contents).not.toContain(CUSTOMER2_FACT);
    expect(result.every((m) => m.customerId === null)).toBe(true);
  });

  it('cross-check via the list() admin view: filtering by customerId=customer1 never returns customer-2 rows', async () => {
    const page = await memory.list(seed.tenantA.id, {
      customerId: customer1,
      page: 1,
      limit: 50,
    } as never);
    expect(page.data.some((m) => m.content === CUSTOMER1_FACT)).toBe(true);
    expect(page.data.some((m) => m.content === CUSTOMER2_FACT)).toBe(false);
  });

  // ── "Conversation" scoping — verified absent, not assumed absent ──────────

  it('[schema finding] recall() does NOT filter by ai_conversation_id — a memory tagged to conversation X is recalled from an UNRELATED conversation Y for the same customer', async () => {
    const convX = await conversations.start(seed.tenantA.id, {});
    const convY = await conversations.start(seed.tenantA.id, {});

    const CONV_X_TAGGED_FACT = `Conversation-X-tagged fact ${convX.id}: patient mentioned a rare condition`;
    await memory.remember(seed.tenantA.id, {
      type: 'note',
      content: CONV_X_TAGGED_FACT,
      customerId: customer1,
      aiConversationId: convX.id,
      importance: 5,
    });

    // Recall scoped only by tenant+customer (exactly what the orchestrator's
    // memoryLoader does, ai-orchestrator.service.ts:310-317 — it never passes
    // aiConversationId as a recall FILTER, only as call attribution/telemetry).
    const recalledFromY = await memory.recall(seed.tenantA.id, {
      query: 'rare condition',
      customerId: customer1,
      limit: 10,
    });
    expect(recalledFromY.some((m) => m.content === CONV_X_TAGGED_FACT)).toBe(true);
    // Documented as a design property (long-term memory is explicitly
    // cross-conversation, per ai-memory.service.ts's own docblock: "Long-term
    // AI memory... recalls them semantically" with no conversation filter),
    // not exploited here as a security defect — recorded precisely in
    // assessment-memory.md rather than silently treated as isolation.
  });
});
