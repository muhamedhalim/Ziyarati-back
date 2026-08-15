/**
 * T096 — tool chaining: sequences of individually low-risk calls, checking
 * whether the CUMULATIVE effect exceeds what any single gate authorized.
 *
 * Three scenarios, each grounded in a specific static finding from W3's
 * inventory pass (`w3-declared-vs-enforced.md`, `w3-tools-public.md`):
 *
 *  A. `get_customer_insurance_status` has NO permission gate (by design, for
 *     a single lookup) — chained across every customer id in a tenant, a
 *     low-privilege authenticated principal can ENUMERATE every patient's
 *     insurance flag, a privacy-relevant read no single call's authorization
 *     posture was designed to prevent in bulk.
 *  B. Public-booking session RESET-on-reselect: does switching the selected
 *     CLINIC mid-conversation truly clear every downstream selection, or can
 *     a stale doctor/service/slot chosen under tenant A survive into a
 *     booking attempt under tenant B?
 *  C. `book_appointment`'s insurance-answer write (`resolveInsurance`) is
 *     gated only by `appointments.create` — chaining TWO individually
 *     "authorized" booking calls for the SAME foreign-to-the-caller customer,
 *     with alternating `hasInsurance` answers, repeatedly flips a stranger's
 *     billing-relevant flag purely from model-supplied prose across turns.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { AI_PUBLIC_TOOL } from '../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { PublicBookingContextService } from '../../src/modules/public-booking/public-booking-context.service';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { Service } from '../../src/entities/Services/Service';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { StaffSchedule } from '../../src/entities/Staff/StaffSchedule';
import { StaffProfile } from '../../src/entities/Staff/StaffProfile';
import { Branch } from '../../src/entities/SaaS-Core/Branch';

describe('W3 — tool chaining, cumulative effect of low-risk calls (T096)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let dispatch: AiToolDispatchService;
  let serviceId: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
    dispatch = harness.app.get(AiToolDispatchService);

    for (const tenantId of [seed.tenantA.id, seed.tenantB.id]) {
      await harness.dataSource.query(
        `INSERT INTO tenant_settings (tenant_id, public_booking_enabled) VALUES ($1, true)
         ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true`,
        [tenantId],
      );
    }

    const services = harness.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({ tenant: { id: seed.tenantA.id } as Tenant, name: 'T096 Synthetic Service', duration_minutes: 30, base_price: 50 }),
    );
    serviceId = service.id;

    // `select_doctor`/`list_branch_doctors` need the seeded staff member to
    // actually appear as working at the branch — the seed fixture creates no
    // StaffSchedule row (same gap fixed in T091 for the strict booking path).
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

  async function deleteAppointment(appointmentId: string) {
    await harness.dataSource.query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]).catch(() => undefined);
  }

  describe('A. insurance-status ENUMERATION via repeated low-risk calls', () => {
    it('AI-003 — a principal with DASHBOARD_ACCESS only (no customers.read) can enumerate BOTH seeded customers\' insurance flags by chaining get_customer_insurance_status with each customerId — no single call is blocked, the CHAIN discloses the whole tenant\'s roster', async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      const ctx: ToolContext = {
        tenantId: seed.tenantA.id,
        aiConversationId: conv.id,
        actorUserId: seed.tenantA.staffUserId,
        permissions: [PERMISSION.DASHBOARD_ACCESS], // deliberately NOT customers.read
      };

      const disclosed: Array<{ customerId: string; known: boolean }> = [];
      for (const customerId of seed.tenantA.customerIds) {
        const result = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS, { customerId }));
        expect(result.success).not.toBe(false); // no permission gate — each individual call is "allowed"
        disclosed.push({ customerId, known: result.known as boolean });
      }

      // The cumulative effect: EVERY customer in the tenant was enumerable
      // in this one chain, by a principal who could not have listed them via
      // customers.read (get_patient_overview/list would refuse this principal).
      expect(disclosed).toHaveLength(seed.tenantA.customerIds.length);
      // eslint-disable-next-line no-console
      console.log('[T096-A] enumerated via chained low-risk calls:', JSON.stringify(disclosed));

      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });
  });

  describe('B. public-booking session reset-on-reselect — CONFIRMED FINDING: the reset silently no-ops', () => {
    it('re-selecting a DIFFERENT clinic mid-conversation does NOT clear selectedServiceIds/selectedDoctorId/selectedStartAt from the PRIOR clinic — the source comment\'s claim ("a new clinic invalidates every downstream choice") does not hold; a SEPARATE tenant-scoped check inside AppointmentsService.create is what actually stops the resulting stale cross-tenant booking attempt', async () => {
      const bookingContext = harness.app.get(PublicBookingContextService);
      const conv = await conversations.start(seed.discoveryTenantId, {});
      await sessions.patch(seed.discoveryTenantId, conv.id, { guestSubject: seed.guestA.id });
      const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };

      // Step 1-4: a full, legitimate tenant-A selection chain.
      await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_CLINIC, { clinicId: seed.tenantA.id }));
      await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_BRANCH, { branchId: seed.tenantA.branchId }));
      await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_SERVICE, { serviceIds: [serviceId] }));
      const doctorSelect = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_DOCTOR, { staffId: seed.tenantA.staffProfileId }));
      expect(doctorSelect.success).not.toBe(false);
      const slotSelect = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_SLOT, { startAt: '2027-06-01T10:00:00Z' }));
      expect(slotSelect.success).not.toBe(false);

      let session = await bookingContext.getSelection(seed.discoveryTenantId, conv.id, seed.guestA);
      expect(session.selectedClinicId).toBe(seed.tenantA.id);
      expect(session.selectedServiceIds).toEqual([serviceId]);
      expect(session.selectedStartAt).toBe('2027-06-01T10:00:00Z');
      expect(session.selectedDoctorId).toBe(seed.tenantA.staffProfileId);

      // Step 5: switch clinics mid-conversation to tenant B (single-branch —
      // select_clinic auto-selects tenant B's own branch, which DOES
      // correctly overwrite selectedBranchId with a concrete value).
      const switchResult = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_CLINIC, { clinicId: seed.tenantB.id }));
      expect(switchResult.success).not.toBe(false);

      session = await bookingContext.getSelection(seed.discoveryTenantId, conv.id, seed.guestA);
      expect(session.selectedClinicId).toBe(seed.tenantB.id);
      expect(session.selectedBranchId).toBe(seed.tenantB.branchId); // this DOES reset correctly — a concrete overwrite, not "undefined"

      // ROOT CAUSE, confirmed by execution: `selectClinic` patches
      // `selectedDoctorId/selectedServiceIds/selectedStartAt: undefined`
      // (ai-tool-dispatch.service.ts:672-675) intending to clear them, but
      // `ConversationSessionService.patch` → `clean()`
      // (conversation-session.service.ts:166-171) "drops undefined keys so a
      // patch never overwrites state with undefined" — a rule written for
      // ordinary partial patches that unintentionally defeats THIS caller's
      // explicit reset intent. The stale tenant-A values survive verbatim.
      expect(session.selectedServiceIds).toEqual([serviceId]); // STALE tenant-A service id — did NOT reset
      expect(session.selectedStartAt).toBe('2027-06-01T10:00:00Z'); // STALE — did NOT reset
      expect(session.selectedDoctorId).toBe(seed.tenantA.staffProfileId); // STALE tenant-A staff id — did NOT reset

      // COMPENSATING CONTROL, confirmed by execution: the stale cross-tenant
      // ids are NOT silently trusted at booking time. `book_public_appointment`
      // reads them straight from this (buggy) session, but
      // `AppointmentsService.create`'s OWN tenant-scoped lookups
      // (`assertStaffAtBranch` against tenant B, `loadServices` against
      // tenant B) independently re-verify every referenced entity belongs to
      // the booking's OWN tenant (B) — the stale tenant-A staff id resolves
      // to nothing under tenant B, so the booking is refused, and no
      // cross-tenant appointment is ever created.
      const beforeB = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1`, [seed.tenantB.id]);
      const bookResult = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT, { fullName: 'Chain Probe', phone: '+15557770000' }));
      expect(bookResult.success).toBe(false);
      expect(typeof bookResult.error).toBe('string');

      const afterB = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1`, [seed.tenantB.id]);
      expect(afterB[0].n).toBe(beforeB[0].n); // no cross-tenant appointment was created despite the broken reset

      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });
  });

  describe('C. repeated insurance-flag overwrite via two individually-authorized booking calls', () => {
    it('a staff principal (appointments.create only) chains TWO book_appointment calls for the SAME foreign-to-them customer, alternating hasInsurance — each call is individually authorized, but the chain repeatedly flips a stranger\'s billing-relevant flag purely from model-supplied prose', async () => {
      const targetCustomerId = seed.tenantA.customerIds[1];
      const readInsurance = async () => {
        const rows = await harness.dataSource.query(`SELECT has_health_insurance FROM customers WHERE id = $1`, [targetCustomerId]);
        return rows[0]?.has_health_insurance as boolean | null;
      };

      const before = await readInsurance();

      const conv1 = await conversations.start(seed.tenantA.id, {});
      const ctx: ToolContext = {
        tenantId: seed.tenantA.id,
        aiConversationId: conv1.id,
        actorUserId: seed.tenantA.staffUserId,
        permissions: [PERMISSION.APPOINTMENTS_CREATE], // no customers.read/update — booking alone is enough
      };

      const first = await dispatch.execute(
        ctx,
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
          branchId: seed.tenantA.branchId,
          customerId: targetCustomerId,
          staffId: seed.tenantA.staffProfileId,
          startAt: '2027-06-02T10:00:00Z',
          serviceIds: [serviceId],
          hasInsurance: true,
        }),
      );
      expect(first.success).not.toBe(false);
      expect(await readInsurance()).toBe(true);

      const conv2 = await conversations.start(seed.tenantA.id, {});
      const second = await dispatch.execute(
        { ...ctx, aiConversationId: conv2.id },
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
          branchId: seed.tenantA.branchId,
          customerId: targetCustomerId,
          staffId: seed.tenantA.staffProfileId,
          startAt: '2027-06-03T10:00:00Z',
          serviceIds: [serviceId],
          hasInsurance: false,
        }),
      );
      expect(second.success).not.toBe(false);
      expect(await readInsurance()).toBe(false); // flipped again — the SECOND authorized call overwrote it

      // eslint-disable-next-line no-console
      console.log(`[T096-C] insurance flag before=${before}, after call 1 (true)=true, after call 2 (false)=false — flipped twice via two individually-authorized bookings`);

      await deleteAppointment(first.appointmentId as string);
      await deleteAppointment(second.appointmentId as string);
      await harness.dataSource.query(`UPDATE customers SET has_health_insurance = $1 WHERE id = $2`, [before, targetCustomerId]);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id IN ($1, $2)`, [conv1.id, conv2.id]);
    });
  });
});
