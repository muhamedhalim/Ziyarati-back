/**
 * Public widget (guest) tool behaviour, observed through REAL gateway turns.
 *
 * The model is a deterministic double that emits exactly one tool call per
 * message. What is under test is the server: the ToolContext AiExecutionService
 * really builds for a guest, the dispatcher, and the discovery SQL. Reading the
 * tool result from the provider request that follows shows exactly what a real
 * model would have been given.
 *
 * Findings covered (ids are the audit's, see specs/ai-chatbot-audit-2026-09):
 *   F-01  guest turns were routed as "authenticated" inside tools  (root cause class G) — FIXED in Phase 0, regression tests below
 *   F-02  public availability offered window starts, not a slot grid (consequence of F-01) — FIXED with F-01 on the public path
 *   F-09  clinic data that exists in the DB but no tool returns it  (class C/E)
 *
 * Convention (Feature 011): a defect test PASSES WHILE THE DEFECT EXISTS. F-01/F-02 have been fixed, so their
 * tests now assert the CORRECT behaviour; F-09 is still open and still asserts its defect.
 */
import { scriptedToolCall as call } from '../security/fixtures/scripted-ai-provider';
import { bootAudit, GuestSession, saveEvidence, type AuditRuntime } from './fixtures/audit-runtime';
import { ReactiveProvider, scriptedToolCall, lastToolResult } from './fixtures/reactive-provider';

describe('public widget — tool behaviour through real gateway turns', () => {
  let rt: AuditRuntime;
  let reactive: ReactiveProvider;
  let g: GuestSession;
  const observed: Record<string, any> = {};

  /** One user message → the model calls `tool(args)` once → returns the tool result the model received. */
  async function viaTurn(tool: string, args: Record<string, unknown>) {
    reactive.setHandler((req) => {
      const hasResult = req.messages.some((m) => m.role === 'tool' && m.name === tool);
      return hasResult ? { content: 'ok' } : { toolCalls: [scriptedToolCall(tool, args)] };
    });
    await g.say(`(audit) ${tool}`);
    return lastToolResult(reactive.capturedRequests, tool);
  }

  beforeAll(async () => {
    rt = await bootAudit();
    reactive = new ReactiveProvider();
    rt.use(reactive);
    g = await GuestSession.start(rt);

    const { full } = rt.seed;
    observed.select_clinic = await viaTurn('select_clinic', { clinicId: full.tenantId });
    observed.select_branch = await viaTurn('select_branch', { branchId: full.branchId });
    observed.list_branch_services = await viaTurn('list_branch_services', {});
    observed.list_branch_doctors = await viaTurn('list_branch_doctors', {});
    observed.select_service = await viaTurn('select_service', { serviceIds: [full.serviceIds.cleaning] });
    observed.select_doctor = await viaTurn('select_doctor', { staffId: full.doctorStaffIds.omar });

    // F-01: after a branch is selected the prompt tells the model to call these with NO arguments.
    observed.branch_info_noargs = await viaTurn('get_branch_info', {});
    observed.branch_info_withid = await viaTurn('get_branch_info', { branchId: full.branchId });
    observed.schedule_noargs = await viaTurn('get_doctor_schedule', {});
    observed.schedule_withids = await viaTurn('get_doctor_schedule', { branchId: full.branchId, staffId: full.doctorStaffIds.omar });
    observed.avail_noargs = await viaTurn('search_public_availability', {});
    observed.avail_withids = await viaTurn('search_public_availability', { branchId: full.branchId, staffId: full.doctorStaffIds.omar, daysAhead: 7 });
    observed.clinic_details = await viaTurn('get_clinic_details', { clinicId: full.tenantId });

    // CONTROL — identical dispatcher and session; only `actorUserId` is unset, which is the
    // ToolContext shape the existing unit/security specs build ("guest has none").
    const ctxNoActor = { ...g.toolCtx(), actorUserId: undefined };
    observed.control_branch_info = await rt.dispatch.execute(ctxNoActor, call('get_branch_info', {}));
    observed.control_schedule = await rt.dispatch.execute(ctxNoActor, call('get_doctor_schedule', {}));
    observed.control_avail = await rt.dispatch.execute(ctxNoActor, call('search_public_availability', {}));
    observed.session_after = await g.session();
  }, 240_000);

  afterAll(async () => {
    saveEvidence('det-01-public-tools', observed);
    await rt?.close();
  }, 60_000);

  // ── the flow that works ────────────────────────────────────────────────────
  it('selection tools record the choice server-side and services/doctors carry price, duration and priceStatus', () => {
    expect(observed.select_clinic.success).toBe(true);
    expect(observed.select_branch.success).toBe(true);
    const svc = observed.list_branch_services.services as any[];
    expect(svc.map((s) => [s.name, s.price, s.durationMinutes, s.priceStatus])).toEqual([
      ['Dental Cleaning', 250, 45, 'PUBLISHED'],
      ['General Consultation', null, 30, 'NOT_PUBLISHED'], // unpriced is reported as NOT_PUBLISHED, never 0
      ['Teeth Whitening', 500, 60, 'PUBLISHED'],
    ]);
    expect((observed.list_branch_doctors.doctors as any[]).map((d) => d.title).sort()).toEqual(['Dentist', 'Dermatologist']);
    expect(observed.session_after).toMatchObject({
      selectedClinicId: rt.seed.full.tenantId,
      selectedBranchId: rt.seed.full.branchId,
      selectedDoctorId: rt.seed.full.doctorStaffIds.omar,
    });
  });

  // ── F-01 (fixed) ───────────────────────────────────────────────────────────
  it('F-01 FIXED: get_branch_info with no arguments (as the prompt instructs) resolves the SELECTED branch from the server-side session', () => {
    const info = observed.branch_info_noargs;
    expect(info.success).toBe(true);
    expect(info.branch.address).toContain('12 Audit Street');
    expect(info.branch.phone).toBe('+966500000111');
    expect(info.workingHoursConfigured).toBe(true);
    const byStatus = (info.workingHours as any[]).map((d) => d.status);
    expect(byStatus.filter((s) => s === 'OPEN')).toHaveLength(5); // Sun-Thu
    expect(byStatus).toContain('CLOSED'); // Friday explicitly closed
    expect(byStatus).toContain('NOT_PUBLISHED'); // Saturday never entered
  });

  it('F-01 FIXED: a model-supplied branchId is ignored on the public surface — the session is the only source, so an injected id cannot point at another clinic', () => {
    // the id the model passed IS the selected one here; the result must be identical to the no-arg call
    expect(observed.branch_info_withid).toEqual(observed.branch_info_noargs);
    expect(JSON.stringify(observed.branch_info_withid)).not.toContain('Branch not found');
  });

  it('F-01 FIXED: get_doctor_schedule resolves branch + doctor from the session and reports the real roster — no false "not available at the selected branch"', () => {
    expect(observed.schedule_noargs.success).toBe(true);
    expect(observed.schedule_noargs.worksAtBranch).toBe(true);
    expect(observed.schedule_noargs.weekly.length).toBeGreaterThan(0);
    expect(observed.schedule_withids).toEqual(observed.schedule_noargs);
    // consistent with availability for the same pair, which was always correct:
    expect(observed.avail_withids.success).toBe(true);
    expect(observed.avail_withids.slotCount).toBeGreaterThan(0);
  });

  it('F-01 FIXED: search_public_availability with no arguments (session-resolved ids, per its own description) returns slots', () => {
    expect(observed.avail_noargs.success).toBe(true);
    expect(observed.avail_noargs.slotCount).toBeGreaterThan(0);
  });

  it('F-01 EQUIVALENCE: the REAL guest turn now returns exactly what the previously-unreachable guest branch returns (control with actorUserId unset)', () => {
    expect(observed.branch_info_noargs).toEqual(observed.control_branch_info);
    expect(observed.schedule_noargs).toEqual(observed.control_schedule);
    expect(observed.avail_noargs).toEqual(observed.control_avail);
    expect(observed.control_schedule.success).toBe(true);
  });

  // ── F-02 (fixed with F-01 on the public path) ───────────────────────────────
  it('F-02 FIXED (public): the selected 45-minute service is applied, so a free 09:00-17:00 day is a real slot grid, not one window start', () => {
    const day = (observed.avail_withids.days as any[])[0];
    expect(day.slots.length).toBeGreaterThanOrEqual(8);
    expect(day.slots.map((s: any) => s.localTime).slice(0, 3)).toEqual(['09:00', '09:45', '10:30']);
    // and no-arg equals with-ids
    expect((observed.avail_noargs.days as any[])[0].slots).toEqual(day.slots);
  });

  // ── the "no acting user" gates must fire for a guest ────────────────────────
  // Before F-01 they tested `!ctx.actorUserId`, which is false for every guest (the subject id fills it), so a guest
  // that named an authenticated-only tool was let through to its body. Each must now refuse on the guest's REAL context.
  it.each([
    ['list_clinic_branches', {}],
    ['list_clinic_doctors', { branchId: 'x' }],
    ['list_clinic_services', { branchId: 'x' }],
    ['check_availability', { branchId: 'x', staffId: 'y', date: '2030-01-01' }],
    ['get_customer_insurance_status', { customerId: 'x' }],
    ['book_appointment', { customerId: 'x' }],
    ['reschedule_appointment', { appointmentId: 'x' }],
    ['cancel_appointment', { appointmentId: 'x' }],
  ])('a guest calling the authenticated-only tool %s is refused as "no acting user" and nothing is executed', async (tool, args) => {
    const res = (await rt.dispatch.execute(g.toolCtx(), call(tool, args as Record<string, unknown>))) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/not available in this context \(no acting user\)/);
  });

  it('staff/WhatsApp turns are unaffected: a principal without the guest flag still takes the authenticated branch (branchId required, tenant-scoped)', async () => {
    const { full } = rt.seed;
    const staffCtx = { ...g.toolCtx(), tenantId: full.tenantId, principal: { ...g.toolCtx().principal!, guest: undefined } } as ReturnType<GuestSession['toolCtx']>;
    const noId = (await rt.dispatch.execute(staffCtx, call('get_branch_info', {}))) as Record<string, unknown>;
    expect(noId.success).toBe(false);
    expect(String(noId.error)).toContain('list_clinic_branches');
    const withId = (await rt.dispatch.execute(staffCtx, call('get_branch_info', { branchId: full.branchId }))) as Record<string, any>;
    expect(withId.success).toBe(true);
    expect(withId.branch.address).toContain('12 Audit Street');
  });

  // ── F-09 ───────────────────────────────────────────────────────────────────
  it('F-09 DEFECT (coverage): get_clinic_details omits every field a patient asks about that exists in the DB — specialty, doctor bio, service description, clinic phone, cancellation policy', () => {
    const blob = JSON.stringify(observed.clinic_details);
    expect(observed.clinic_details.success).toBe(true);
    expect(blob).toContain('Dental Cleaning'); // what IS exposed
    expect(blob).not.toContain('AuditDermatology'); // staff/tenant specialty (seeded in staff_specialties/tenant_specialties)
    expect(blob).not.toContain('bio-marker'); // staff_profiles.bio
    expect(blob).not.toContain('published description'); // services.description
    expect(blob).not.toContain('+966500000777'); // tenants.contact_phone
    expect(blob).not.toMatch(/cancel/i); // tenant_settings.cancellation_hours = 24 is seeded
  });
});
