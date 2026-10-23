/**
 * T100 — least-privilege actor for tenant-behalf writes: confirm
 * `book_public_appointment` (the one write in the public-booking catalog)
 * executes under the SELECTED clinic's own `ai-bot` actor — a real, per-tenant
 * `users` row with the minimal `AI_BOT_PERMISSIONS` role — never the guest's
 * own (nonexistent) identity, and never an elevated/staff/platform identity.
 *
 * `ai-tool-dispatch.service.ts:878-881`: `bot = await this.botActor
 * .ensureBotActor(booking.tenantId)`, then `this.tenantContext.run(() => {
 * this.tenantContext.setPrincipal(bot); ... this.appointments.create(
 * booking.tenantId, bot.id, {...}) })` — `bot.id` becomes
 * `Appointment.booked_by`. This file verifies the PERSISTED actor id and
 * permission set from the database, not from reading that call site.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_PUBLIC_TOOL } from '../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { WhatsappBotActorService } from '../../src/modules/whatsapp/whatsapp-bot-actor.service';
import { PublicBookingContextService } from '../../src/modules/public-booking/public-booking-context.service';
import { AI_BOT_PERMISSIONS, ROLE, NON_STAFF_ROLE_SLUGS } from '../../src/rbac/rbac.constants';
import { Service } from '../../src/entities/Services/Service';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { StaffSchedule } from '../../src/entities/Staff/StaffSchedule';
import { StaffProfile } from '../../src/entities/Staff/StaffProfile';
import { Branch } from '../../src/entities/SaaS-Core/Branch';

describe('W3 — bot-actor least privilege for tenant-behalf writes (T100)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let dispatch: AiToolDispatchService;
  let botActor: WhatsappBotActorService;
  let serviceId: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
    dispatch = harness.app.get(AiToolDispatchService);
    botActor = harness.app.get(WhatsappBotActorService);

    for (const tenantId of [seed.tenantA.id, seed.tenantB.id]) {
      await harness.dataSource.query(
        `INSERT INTO tenant_settings (tenant_id, public_booking_enabled) VALUES ($1, true)
         ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true`,
        [tenantId],
      );
    }

    const services = harness.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({ public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`, tenant: { id: seed.tenantA.id } as Tenant, name: 'T100 Service', duration_minutes: 30, base_price: 40 }),
    );
    serviceId = service.id;

    const schedules = harness.dataSource.getRepository(StaffSchedule);
    await schedules.save(
      Array.from({ length: 7 }, (_, day_of_week) =>
        schedules.create({
          staff: { id: seed.tenantA.staffProfileId } as StaffProfile,
          branch: { id: seed.tenantA.branchId } as Branch,
          tenant: { id: seed.tenantA.id } as Tenant,
          day_of_week,
          start_time: '00:00',
          end_time: '23:59',
          is_active: true,
        }),
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM staff_schedules WHERE "staffId" = $1`, [seed.tenantA.staffProfileId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM services WHERE id = $1`, [serviceId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('sanity: AI_BOT_PERMISSIONS is exactly the documented 7-slug least-privilege set, and "ai-bot" is a NON-staff role slug (cannot be assigned via normal staff management)', () => {
    expect(AI_BOT_PERMISSIONS.slice().sort()).toEqual(
      ['appointments.create', 'appointments.read', 'appointments.reschedule', 'appointments.cancel', 'scheduling.availability.read', 'customers.read', 'customers.create'].sort(),
    );
    expect(NON_STAFF_ROLE_SLUGS as readonly string[]).toContain(ROLE.AI_BOT);
  });

  it('a guest-driven book_public_appointment persists Appointment.booked_by = the TENANT\'S OWN ai-bot user id — never the guest, never staff, never super-admin', async () => {
    const bot = await botActor.ensureBotActor(seed.tenantA.id);
    expect(bot.roles).toContain(ROLE.AI_BOT);
    expect(bot.id).not.toBe(seed.tenantA.staffUserId); // not the seeded staff/doctor identity

    const conv = await conversations.start(seed.discoveryTenantId, {});
    await sessions.patch(seed.discoveryTenantId, conv.id, { guestSubject: seed.guestA.id });
    const realBookingContext = harness.app.get(PublicBookingContextService);
    await realBookingContext.patchSelection(seed.discoveryTenantId, conv.id, {
      selectedClinicId: seed.tenantA.id,
      selectedBranchId: seed.tenantA.branchId,
      selectedDoctorId: seed.tenantA.staffProfileId,
      selectedServiceIds: [serviceId],
      selectedStartAt: '2027-09-01T10:00:00Z',
    });

    const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT, { fullName: 'Bot Actor Probe', phone: '+15556660000' }));
    expect(result.success).not.toBe(false);
    const appointmentId = result.appointmentId as string;

    const row = await harness.dataSource.query(`SELECT "bookedById" FROM appointments WHERE id = $1`, [appointmentId]);
    expect(row[0].bookedById).toBe(bot.id); // the TENANT'S OWN bot actor, confirmed against the real ensureBotActor() result
    expect(row[0].bookedById).not.toBe(seed.guestA.id); // guest has no User row at all — could never be booked_by
    expect(row[0].bookedById).not.toBe(seed.tenantA.staffUserId); // not the tenant's staff/doctor
    expect(row[0].bookedById).not.toBe(seed.tenantB.staffUserId); // not another tenant's staff

    // The persisted actor's OWN permission set, read fresh from the DB via
    // the exact same role-resolution path production uses — never assumed
    // from the constant alone.
    const persistedBotPermissions = (await botActor.ensureBotActor(seed.tenantA.id)).permissions;
    expect(persistedBotPermissions.slice().sort()).toEqual(AI_BOT_PERMISSIONS.slice().sort());
    // No elevated/platform/financial/AI-config permission ever appears.
    for (const forbidden of ['ai.manage', 'ai.agents.manage', 'subscription.manage', 'payments.manage', 'refunds.manage', 'staff.manage', 'tenants.manage']) {
      expect(persistedBotPermissions).not.toContain(forbidden);
    }

    await harness.dataSource.query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]);
    await harness.dataSource.query(`DELETE FROM customers WHERE "tenantId" = $1 AND phone = $2`, [seed.tenantA.id, '+15556660000']);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 20_000);

  it('AI-001 — REMEDIATED (RTP row 1): the bot actor IS scoped per tenant — a SECOND (and Nth) tenant provisioning its ai-bot actor now succeeds, because WhatsappBotActorService derives a tenant-qualified address (RFC 5233 sub-addressing, R10) instead of hardcoding the SAME literal email for every tenant, while migration 1730035000000-GlobalUserEmailUniqueness ("D7") still enforces users\' email uniqueness GLOBALLY', async () => {
    // Tenant A's bot provisions fine (already proven above and in the
    // previous test in this file) — the fix must hold for every subsequent
    // tenant too, in the SAME database.
    const botA = await botActor.ensureBotActor(seed.tenantA.id);
    expect(botA.tenantId).toBe(seed.tenantA.id);

    // `WhatsappBotActorService.botEmailFor()`'s doc comment
    // (`whatsapp-bot-actor.service.ts`) now correctly states `users.email` is
    // unique GLOBALLY (`uq_user_email_global`, migration `1730035000000`),
    // not per tenant — that global constraint is migration
    // `1730035000000-GlobalUserEmailUniqueness.ts`'s ("D7") deliberate,
    // documented behaviour, unchanged by this fix. `ensureBotUser`
    // (`whatsapp-bot-actor.service.ts`) now derives a distinct,
    // deterministic address per tenant (`ai-bot+<tenantId>@bot.internal`)
    // instead of the identical literal every tenant previously shared.
    //
    // Observed, executed result: tenant B's FIRST-EVER bot provisioning
    // attempt succeeds, with a distinct email from tenant A's. In production
    // this means: every tenant — not just whichever one happens to
    // provision an AI-bot actor first platform-wide — gets working WhatsApp
    // AI booking (`ai-tool-dispatch.service.ts`'s WhatsApp-bound paths that
    // restore this principal) and public/guest AI booking
    // (`book_public_appointment`) — the very mechanism T100 exists to verify
    // (least-privilege, per-tenant actor isolation).
    const botB = await botActor.ensureBotActor(seed.tenantB.id);
    expect(botB.tenantId).toBe(seed.tenantB.id);

    // Confirms each tenant got its OWN distinct, tenant-qualified address —
    // direct evidence the fix, not a coincidence, is what let both succeed.
    const rowA = await harness.dataSource.query(`SELECT "tenantId", email FROM users WHERE "tenantId" = $1 AND email LIKE 'ai-bot+%@bot.internal' AND deleted_at IS NULL`, [seed.tenantA.id]);
    const rowB = await harness.dataSource.query(`SELECT "tenantId", email FROM users WHERE "tenantId" = $1 AND email LIKE 'ai-bot+%@bot.internal' AND deleted_at IS NULL`, [seed.tenantB.id]);
    expect(rowA).toHaveLength(1);
    expect(rowB).toHaveLength(1);
    expect(rowA[0].email).not.toBe(rowB[0].email); // distinct addresses, not a shared literal

    // The bare legacy literal is never used by a fresh provisioning under the fix.
    const legacy = await harness.dataSource.query(`SELECT 1 FROM users WHERE email = 'ai-bot@bot.internal' AND deleted_at IS NULL`);
    expect(legacy).toHaveLength(0);
  });
});
