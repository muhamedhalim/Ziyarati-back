/**
 * T039 — server-only session-key reproduction test (FR-019, FR-030).
 *
 * `ai-channel.constants.ts`'s own docblock names the exact keys a client patch
 * must never be able to set: `guestSubject` (the FND-001 ownership binding),
 * `selected*` (booking selections — the indirect tenant-injection risk),
 * `activeChannel`/`lastChannel`/`channelHistory`, and `currentAgentRole`; plus
 * `context.customerId`/`context.recalledMemories` inside the nested `context`
 * blob (`SESSION_CONTEXT_SERVER_ONLY_KEYS`). `ConversationSessionService.
 * patchFromClient` is documented as "the ONLY entry point any client-facing
 * path may use" and is supposed to strip all of these via `stripServerOwned`.
 *
 * This test drives the REAL `patchFromClient` method against a real
 * persisted conversation and asserts from the RE-READ, PERSISTED row — never
 * the return value alone — that none of the attempted keys took effect.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { SESSION_CLIENT_PATCHABLE_KEYS } from '../../src/modules/ai-orchestrator/ai-channel.constants';

describe('AI session-patch server-only key enforcement (T039)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  /** Reads the session directly off the database row (not the service's in-memory return value). */
  async function readPersistedSession(tenantId: string, conversationId: string): Promise<Record<string, unknown>> {
    const rows = await harness.dataSource.query(
      `SELECT session FROM ai_conversations WHERE id = $1 AND "tenantId" = $2`,
      [conversationId, tenantId],
    );
    return rows[0]?.session ?? {};
  }

  const ATTACK_PATCH = {
    // Server-write-only top-level keys, per ai-channel.constants.ts:
    guestSubject: 'attacker-controlled-guest-sub',
    selectedClinicId: 'attacker-controlled-tenant-id',
    selectedBranchId: 'attacker-controlled-branch-id',
    selectedDoctorId: 'attacker-controlled-doctor-id',
    selectedServiceIds: ['attacker-service'],
    selectedStartAt: '2099-01-01T00:00:00Z',
    bookingCustomerId: 'attacker-controlled-customer-id',
    activeChannel: 'WHATSAPP',
    lastChannel: 'WHATSAPP',
    channelHistory: [{ channel: 'WHATSAPP', at: '2099-01-01T00:00:00Z' }],
    currentAgentRole: 'SUPERVISOR',
    // Nested server-only context keys:
    context: { customerId: 'attacker-controlled-context-customer-id', recalledMemories: ['fabricated memory'] },
  } as const;

  it('strips every server-write-only top-level key when patched via patchFromClient', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});

    await sessions.patchFromClient(seed.tenantA.id, conv.id, ATTACK_PATCH as never);

    const persisted = await readPersistedSession(seed.tenantA.id, conv.id);
    expect(persisted.guestSubject).not.toBe(ATTACK_PATCH.guestSubject);
    expect(persisted.selectedClinicId).not.toBe(ATTACK_PATCH.selectedClinicId);
    expect(persisted.selectedBranchId).not.toBe(ATTACK_PATCH.selectedBranchId);
    expect(persisted.selectedDoctorId).not.toBe(ATTACK_PATCH.selectedDoctorId);
    expect(persisted.selectedServiceIds).not.toEqual(ATTACK_PATCH.selectedServiceIds);
    expect(persisted.selectedStartAt).not.toBe(ATTACK_PATCH.selectedStartAt);
    expect(persisted.bookingCustomerId).not.toBe(ATTACK_PATCH.bookingCustomerId);
    expect(persisted.activeChannel).not.toBe(ATTACK_PATCH.activeChannel);
    expect(persisted.lastChannel).not.toBe(ATTACK_PATCH.lastChannel);
    expect(persisted.channelHistory).not.toEqual(ATTACK_PATCH.channelHistory);
    expect(persisted.currentAgentRole).not.toBe(ATTACK_PATCH.currentAgentRole);

    // None of the attempted top-level server-only keys should even be present
    // (stripServerOwned removes them entirely rather than nulling them).
    const serverOnlyTopLevelKeys = [
      'guestSubject', 'selectedClinicId', 'selectedBranchId', 'selectedDoctorId',
      'selectedServiceIds', 'selectedStartAt', 'bookingCustomerId',
      'activeChannel', 'lastChannel', 'channelHistory', 'currentAgentRole',
    ];
    for (const key of serverOnlyTopLevelKeys) {
      expect(persisted[key]).toBeUndefined();
    }

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  it('strips server-only keys NESTED inside the context blob (context.customerId, context.recalledMemories)', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});

    await sessions.patchFromClient(seed.tenantA.id, conv.id, ATTACK_PATCH as never);

    const persisted = await readPersistedSession(seed.tenantA.id, conv.id);
    const context = (persisted.context ?? {}) as Record<string, unknown>;
    expect(context.customerId).toBeUndefined();
    expect(context.recalledMemories).toBeUndefined();

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  it('control case: the documented CLIENT-patchable keys DO take effect (proves stripServerOwned is not simply dropping everything)', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});

    const benignPatch = {
      currentIntent: 'book_appointment',
      language: 'ar',
      device: 'ios',
      timezone: 'Africa/Cairo',
      currentTool: 'search_public_availability',
      currentBooking: { note: 'benign client-side draft' },
      authState: 'anonymous',
      context: { someClientField: 'ok' },
    };
    // Every key in benignPatch must be a documented client-patchable key
    // (guards this test itself against silently testing the wrong thing).
    for (const key of Object.keys(benignPatch)) {
      if (key === 'context') continue; // context is patchable at the top level; server-only keys live INSIDE it
      expect((SESSION_CLIENT_PATCHABLE_KEYS as readonly string[]).includes(key)).toBe(true);
    }

    await sessions.patchFromClient(seed.tenantA.id, conv.id, benignPatch as never);

    const persisted = await readPersistedSession(seed.tenantA.id, conv.id);
    expect(persisted.currentIntent).toBe('book_appointment');
    expect(persisted.language).toBe('ar');
    expect(persisted.device).toBe('ios');
    expect(persisted.timezone).toBe('Africa/Cairo');
    expect((persisted.context as Record<string, unknown>).someClientField).toBe('ok');

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });
});
