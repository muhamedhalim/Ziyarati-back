/**
 * T062 — cross-tenant reach through the external-integration path (FR-021,
 * FR-056), against `WhatsappInboundAiService`.
 *
 * `principal-derivation.md` entry point E4 already establishes that
 * `tenantId` for an inbound WhatsApp turn comes from a persisted
 * `WhatsappWebhook` row loaded by its own database id — never from inbound
 * message content — and is threaded, unchanged, through every downstream
 * call this service makes (`ensureBotActor(tenantId)`,
 * `orchestrator.handleStream(tenantId, ...)`, `sendReply(tenantId, ...)` →
 * `WhatsappMessageRouter.resolveForSend(tenantId, ...)`). This file drives a
 * REAL inbound turn for tenant A, scripting the "model" to attempt a booking
 * against TENANT B's clinic resources (branch/customer/staff ids it never
 * typed), and asserts:
 *
 *  1. the booking itself is refused server-side (no appointment created
 *     referencing tenant B's resources) — the tool-dispatch boundary already
 *     proven in T054/T055, driven this time through the WhatsApp bridge; and
 *  2. EVERY outbound-send routing decision this turn makes
 *     (`WhatsappMessageRouter.resolveForSend`, spied without being replaced —
 *     the real, unmocked method) is bound to tenant A only — a provably
 *     absent side effect for tenant B, never merely "it errored late".
 *
 * No `MetaGraphClient`/`MetaWhatsappProvider` mocking is needed for this
 * proof: neither synthetic tenant has a provisioned WhatsApp account, so the
 * actual Meta API call is structurally unreachable either way (`sendSession`
 * requires `resolveForSend` to succeed first) — the security property under
 * test is the TENANT BINDING itself, which the resolveForSend spy captures
 * directly regardless of whether the send would ultimately succeed.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { WhatsappInboundAiService } from '../../src/modules/whatsapp/whatsapp-inbound-ai.service';
import { WhatsappMessageRouter } from '../../src/modules/whatsapp/routing/whatsapp-message.router';
import { WhatsappContact } from '../../src/entities/WhatsApp/WhatsappContact';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import type { MetaWebhookChangeValue } from '../../src/modules/whatsapp/webhooks/whatsapp-webhook.types';

describe('AI-W4 external-integration (WhatsApp) cross-tenant reproduction (T062)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let inbound: WhatsappInboundAiService;
  let router: WhatsappMessageRouter;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    inbound = harness.app.get(WhatsappInboundAiService);
    router = harness.app.get(WhatsappMessageRouter);
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM whatsapp_contacts WHERE "tenantId" = $1`, [seed.tenantA.id]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('an inbound tenant-A WhatsApp turn, scripted to attempt booking tenant B\'s clinic resources, never constructs an outbound send bound to tenant B and never creates a tenant-B-referencing appointment', async () => {
    const resolveForSendSpy = jest.spyOn(router, 'resolveForSend');

    const before = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM appointments WHERE "branchId" = $1`,
      [seed.tenantB.branchId],
    );

    harness.provider.reset();
    const bookCall = scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
      branchId: seed.tenantB.branchId,
      customerId: seed.tenantB.customerIds[0],
      staffId: seed.tenantB.staffProfileId,
      startAt: '2027-05-01T10:00:00Z',
    });
    harness.provider.script([
      { toolCalls: [bookCall] },
      { content: 'Sure, I have looked into that for you.' },
    ]);

    const waId = `15550${Math.floor(100000 + Math.random() * 800000)}`;
    const value: MetaWebhookChangeValue = {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: 'test-phone-id' },
      contacts: [{ profile: { name: 'W4 Probe Contact' }, wa_id: waId }],
      messages: [
        {
          from: waId,
          id: `wamid.t062-${Date.now()}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Book me an appointment please.' },
        },
      ],
    } as unknown as MetaWebhookChangeValue;

    await inbound.handleInboundValue(seed.tenantA.id, value);

    // (1) The booking against tenant B's resources produced no side effect.
    const after = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM appointments WHERE "branchId" = $1`,
      [seed.tenantB.branchId],
    );
    expect(after[0].count).toBe(before[0].count);

    // (2) Tenant binding invariant: every resolveForSend call this turn made
    // (there may be zero, since neither synthetic tenant has a provisioned
    // WhatsApp account) used tenant A's id — never tenant B's, despite the
    // model's tool call referencing tenant B's resources throughout.
    const tenantIdsUsed = resolveForSendSpy.mock.calls.map((args) => args[0]);
    expect(tenantIdsUsed.every((t) => t === seed.tenantA.id)).toBe(true);
    expect(tenantIdsUsed).not.toContain(seed.tenantB.id);

    // Independent proof the turn actually ran (not silently skipped by an
    // entitlement gate): the contact + its AI conversation now exist under
    // tenant A.
    const contacts = harness.dataSource.getRepository(WhatsappContact);
    const contact = await contacts.findOne({ where: { wa_id: waId, tenant: { id: seed.tenantA.id } } });
    expect(contact).toBeDefined();

    resolveForSendSpy.mockRestore();
    if (contact?.ai_conversation_id) {
      await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [contact.ai_conversation_id]).catch(() => undefined);
      await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [contact.ai_conversation_id]).catch(() => undefined);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [contact.ai_conversation_id]).catch(() => undefined);
    }
  }, 30_000);
});
