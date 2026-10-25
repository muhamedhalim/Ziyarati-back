import { AppError, ErrorCode } from '../../../common/errors';
import { AppointmentStatus } from '../../../entities/enums';
import { SESSION_UNSET } from '../../ai-orchestrator/conversation-session.service';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { AiToolDispatchService } from './ai-tool-dispatch.service';

/**
 * Characterization of the appointment-change and public-booking tools, driven
 * through `execute()` exactly as the model's calls reach them. Written before
 * those clusters were moved into their own handler classes and kept as the
 * contract that move must not change.
 */
describe('AiToolDispatchService — appointment-change and public-booking tools (characterization)', () => {
  const UUID = '123e4567-e89b-12d3-a456-426614174000';
  const UUID2 = '223e4567-e89b-12d3-a456-426614174000';
  const FUTURE = () => new Date(Date.now() + 72 * 3_600_000);

  function build() {
    const attempts: any[][] = [];
    const query = jest.fn(async (sql: string, params: any[]) => {
      if (String(sql).includes('INSERT INTO ai_tool_calls') && params?.[7]?.startsWith?.('attempt:')) {
        attempts.push(params);
      }
      if (String(sql).includes('INSERT INTO ai_tool_calls') && !params?.[7]?.startsWith?.('attempt:')) {
        return [{ id: 'row-1' }];
      }
      return [];
    });
    const session: Record<string, any> = { pendingConfirmations: {} };
    const sessions = {
      get: jest.fn(async () => session),
      patch: jest.fn(async (_t: string, _c: string, p: any) => Object.assign(session, p)),
    };
    const appointments = {
      findOne: jest.fn(),
      findAll: jest.fn(),
      cancel: jest.fn(async (_t: string, _a: string, id: string) => ({ id, status: 'CANCELLED' })),
      reschedule: jest.fn(async (_t: string, _a: string, id: string) => ({
        id, start_at: 'S', end_at: 'E',
      })),
    };
    const tenants = { getSettings: jest.fn(async () => ({ cancellation_hours: 24 })) };
    const discovery = {
      cityCoverage: jest.fn(),
      clinicDetail: jest.fn(),
      listBranchServices: jest.fn(),
      listBranchDoctors: jest.fn(),
    };
    const bookingContext = {
      getSelection: jest.fn(async () => ({})),
      patchSelection: jest.fn(async () => ({ language: 'en' })),
      resolveTenantFromBranch: jest.fn(),
      requireContext: jest.fn(),
    };
    const deps: any[] = new Array(18).fill({});
    deps[0] = appointments;
    deps[2] = discovery;
    deps[9] = { query };
    deps[11] = tenants;
    deps[13] = bookingContext;
    deps[15] = { getCorrelationId: () => 'corr' };
    deps[16] = sessions;
    const service: any = new (AiToolDispatchService as any)(...deps);
    const call = (name: string, args: any, ctx: any) =>
      service.execute(
        { tenantId: 't1', aiConversationId: 'c1', turnId: 'turn-1', ...ctx },
        { id: 'x', name, arguments: JSON.stringify(args) },
      );
    return { service, call, attempts, appointments, tenants, discovery, bookingContext, session, query };
  }

  const STAFF = { actorUserId: 'u1', permissions: [PERMISSION.APPOINTMENTS_CANCEL, PERMISSION.APPOINTMENTS_RESCHEDULE, PERMISSION.APPOINTMENTS_READ] };
  const appt = (over: any = {}) => ({
    id: UUID, status: AppointmentStatus.CONFIRMED, start_at: FUTURE(),
    customer: { id: 'cust-1' }, staff: { id: 'sp-1' }, branch: { name: 'Main', timezone: 'Asia/Riyadh' },
    services: [{ service: { name: 'Checkup' } }], ...over,
  });

  describe('cancel_appointment', () => {
    it('refuses a guest / no acting user', async () => {
      const { call } = build();
      await expect(call('cancel_appointment', { appointmentId: UUID }, {})).resolves.toEqual({
        success: false, error: 'Cancellation is not available in this context (no acting user).',
      });
    });

    it('refuses and records a DENIED attempt without the cancel permission', async () => {
      const { call, attempts } = build();
      const r = await call('cancel_appointment', { appointmentId: UUID }, { actorUserId: 'u1', permissions: [] });
      expect(r.error).toBe('Forbidden: cancellation requires the "appointments.cancel" permission.');
      expect(attempts[0][5]).toBe('DENIED');
    });

    it('validates the id: required, then UUID shape', async () => {
      const { call } = build();
      await expect(call('cancel_appointment', {}, STAFF)).resolves.toEqual({ success: false, error: 'appointmentId is required.' });
      const bad = await call('cancel_appointment', { appointmentId: 'nope' }, STAFF);
      expect(bad.error).toContain('appointmentId must be the UUID exactly as returned by the tool that listed it');
      const badBound = await call('cancel_appointment', { appointmentId: 'nope' }, { ...STAFF, customerId: 'cust-1' });
      expect(badBound.error).toContain('returned by list_my_appointments');
    });

    it('a staff principal needs a confirmation turn first, then a later turn executes it once', async () => {
      const { call, appointments, attempts } = build();
      const first = await call('cancel_appointment', { appointmentId: UUID }, STAFF);
      expect(first).toMatchObject({ success: false, confirmationRequired: true });
      expect(first.confirmationToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.error).toContain('Nothing has changed yet.');
      expect(appointments.cancel).not.toHaveBeenCalled();
      expect(attempts[0].slice(5, 7)).toEqual(['REFUSED', 'Requires confirmation before it will cancel this appointment.']);

      const same = await call('cancel_appointment', { appointmentId: UUID }, STAFF);
      expect(same).toMatchObject({ confirmationRequired: true, awaitingPatientReply: true });

      const later = await call('cancel_appointment', { appointmentId: UUID }, { ...STAFF, turnId: 'turn-2' });
      expect(later).toEqual({ success: true, appointmentId: UUID, status: 'CANCELLED' });
      expect(appointments.cancel).toHaveBeenCalledWith('t1', 'u1', UUID, { reason: undefined });
    });

    it('a patient-bound turn can only touch the patient\'s own appointment', async () => {
      const { call, appointments, attempts } = build();
      appointments.findOne.mockResolvedValue(appt({ customer: { id: 'someone-else' } }));
      const r = await call('cancel_appointment', { appointmentId: UUID }, { ...STAFF, customerId: 'cust-1' });
      expect(r.error).toBe('No upcoming appointment with that id belongs to this patient. Call list_my_appointments and use an id it returns.');
      expect(attempts[0].slice(5, 7)).toEqual(['DENIED', 'Appointment not found for this patient.']);
    });

    it('treats a missing appointment like another patient\'s (one uniform answer)', async () => {
      const { call, appointments } = build();
      appointments.findOne.mockRejectedValue(new AppError(ErrorCode.NOT_FOUND, { message: 'nf' }));
      const r = await call('cancel_appointment', { appointmentId: UUID }, { ...STAFF, customerId: 'cust-1' });
      expect(r.error).toContain('belongs to this patient');
    });

    it('refuses a WhatsApp turn with no bound patient', async () => {
      const { call } = build();
      const r = await call('cancel_appointment', { appointmentId: UUID }, { ...STAFF, channel: 'WHATSAPP' });
      expect(r.error).toContain('No patient is identified for this conversation.');
    });

    it('refuses inside the clinic change window, naming the policy', async () => {
      const { call, appointments } = build();
      appointments.findOne.mockResolvedValue(appt({ start_at: new Date(Date.now() + 3_600_000) }));
      const r = await call('cancel_appointment', { appointmentId: UUID }, { ...STAFF, customerId: 'cust-1' });
      expect(r).toMatchObject({ success: false, blockedReason: 'WINDOW_CLOSED', changeWindowHours: 24 });
      expect(r.error).toContain('Clinic policy: an appointment can only be changed at least 24 hours before it starts');
    });

    it('refuses a finished appointment', async () => {
      const { call, appointments } = build();
      appointments.findOne.mockResolvedValue(appt({ status: AppointmentStatus.NO_SHOW }));
      const r = await call('cancel_appointment', { appointmentId: UUID }, { ...STAFF, customerId: 'cust-1' });
      expect(r.error).toBe('This appointment is no show and can no longer be changed.');
    });

    it('a patient-bound proposal carries the appointment as the patient should hear it', async () => {
      const { call, appointments, query } = build();
      appointments.findOne.mockResolvedValue(appt());
      const origQuery = query.getMockImplementation()!;
      query.mockImplementation(async (sql: string, p: any[]) =>
        String(sql).includes('FROM staff_profiles') ? [{ id: 'sp-1', name: 'Dr  Amal' }] : origQuery(sql, p));
      const r = await call('cancel_appointment', { appointmentId: UUID }, { ...STAFF, customerId: 'cust-1' });
      expect(r.confirmationRequired).toBe(true);
      expect(r.appointment).toMatchObject({
        appointmentId: UUID, status: 'CONFIRMED', branch: 'Main', doctor: 'Dr Amal', services: ['Checkup'],
        local: { timezone: 'Asia/Riyadh' },
      });
    });
  });

  describe('reschedule_appointment', () => {
    it('requires both arguments and a valid timestamp', async () => {
      const { call } = build();
      await expect(call('reschedule_appointment', { appointmentId: UUID }, STAFF)).resolves.toEqual({
        success: false, error: 'appointmentId and newStartAt are required.',
      });
      await expect(call('reschedule_appointment', { appointmentId: UUID, newStartAt: 'soon' }, STAFF)).resolves.toEqual({
        success: false, error: 'newStartAt must be a valid ISO-8601 timestamp.',
      });
    });

    it('is permission-gated and records the denial', async () => {
      const { call, attempts } = build();
      const r = await call('reschedule_appointment', { appointmentId: UUID, newStartAt: FUTURE().toISOString() }, { actorUserId: 'u1', permissions: [] });
      expect(r.error).toBe('Forbidden: rescheduling requires the "appointments.reschedule" permission.');
      expect(attempts[0][5]).toBe('DENIED');
    });

    it('confirms first, keyed to the exact instant, then a later turn moves it', async () => {
      const { call, appointments } = build();
      const iso = FUTURE().toISOString();
      const first = await call('reschedule_appointment', { appointmentId: UUID, newStartAt: iso }, STAFF);
      expect(first).toMatchObject({ confirmationRequired: true });
      const done = await call('reschedule_appointment', { appointmentId: UUID, newStartAt: iso }, { ...STAFF, turnId: 'turn-2' });
      expect(done).toEqual({ success: true, appointmentId: UUID, startAt: 'S', endAt: 'E' });
      expect(appointments.reschedule).toHaveBeenCalledWith('t1', 'u1', UUID, { newStartAt: iso, reason: undefined });
    });
  });

  describe('list_my_appointments', () => {
    const OWN = { ...STAFF, customerId: 'cust-1' };

    it('guards: guest, permission, no bound patient', async () => {
      const { call } = build();
      expect((await call('list_my_appointments', {}, {})).error).toBe('This tool is not available in this context (no acting user).');
      expect((await call('list_my_appointments', {}, { actorUserId: 'u1', permissions: [] })).error)
        .toBe('Forbidden: listing appointments requires the "appointments.read" permission.');
      expect((await call('list_my_appointments', {}, STAFF)).error).toContain('No patient is identified for this conversation');
    });

    it('lists only live upcoming appointments with the change-window flag and no ids to show', async () => {
      const { call, appointments } = build();
      appointments.findAll.mockResolvedValue({
        data: [
          appt({ id: UUID }),
          appt({ id: UUID2, status: AppointmentStatus.CANCELLED }),
          appt({ id: 'soon-1', start_at: new Date(Date.now() + 3_600_000) }),
        ],
      });
      const r = await call('list_my_appointments', {}, OWN);
      expect(r).toMatchObject({ success: true, count: 2, changeWindowHours: 24 });
      expect(r.appointments.map((a: any) => [a.appointmentId, a.canChangeOnline])).toEqual([[UUID, true], ['soon-1', false]]);
      expect(r.guidance).toContain('never show the id');
      const [, query, actor] = appointments.findAll.mock.calls[0];
      expect(query).toMatchObject({ customerId: 'cust-1', order: 'ASC', page: 1, limit: 20 });
      expect(actor).toEqual({ id: 'u1', permissions: STAFF.permissions });
    });

    it('says so when there is nothing upcoming', async () => {
      const { call, appointments } = build();
      appointments.findAll.mockResolvedValue({ data: [] });
      const r = await call('list_my_appointments', {}, OWN);
      expect(r).toMatchObject({ success: true, count: 0 });
      expect(r.guidance).toBe('This patient has no upcoming appointment. Say so, and offer to book one.');
    });
  });

  describe('public booking tools', () => {
    const GUEST = { actorUserId: 'g1', principal: { guest: true } };

    it('list_cities explains an empty result', async () => {
      const { call, discovery } = build();
      discovery.cityCoverage.mockResolvedValue({ cities: [], bookableClinics: 0, clinicsWithoutCity: 0 });
      const r = await call('list_cities', {}, GUEST);
      expect(r).toMatchObject({ success: true, cityCount: 0, bookableClinics: 0 });
      expect(r.guidance).toContain('No clinic has opted in to public booking');
      discovery.cityCoverage.mockResolvedValue({ cities: [{ id: 'x' }], bookableClinics: 3, clinicsWithoutCity: 0 });
      expect((await call('list_cities', {}, GUEST)).guidance).toBe('Ask which city, then pass its id to search_clinics as cityId.');
    });

    it('select_clinic: shape check, ineligible clinic, single-branch auto-select with the cascade reset', async () => {
      const { call, discovery, bookingContext } = build();
      expect((await call('select_clinic', { clinicId: 'name' }, GUEST)).error).toContain('clinicId must be the UUID exactly as returned by search_clinics');
      discovery.clinicDetail.mockRejectedValueOnce(new Error('x'));
      expect((await call('select_clinic', { clinicId: UUID }, GUEST)).error).toContain('No bookable clinic has that id.');

      discovery.clinicDetail.mockResolvedValue({ clinic: { id: UUID }, branches: [{ id: 'b1' }] });
      const r = await call('select_clinic', { clinicId: UUID }, GUEST);
      expect(r).toEqual({ success: true, clinic: { id: UUID }, branches: [{ id: 'b1' }], branchAutoSelected: true, selectedBranch: { id: 'b1' } });
      expect(bookingContext.patchSelection).toHaveBeenLastCalledWith('t1', 'c1', {
        selectedClinicId: UUID, selectedBranchId: 'b1',
        selectedDoctorId: SESSION_UNSET, selectedServiceIds: SESSION_UNSET, selectedStartAt: SESSION_UNSET,
      });
    });

    it('select_clinic adds re-selection guidance in the conversation language when something was already chosen', async () => {
      const { call, discovery, bookingContext } = build();
      discovery.clinicDetail.mockResolvedValue({ clinic: {}, branches: [{ id: 'a' }, { id: 'b' }] });
      bookingContext.getSelection.mockResolvedValue({ selectedDoctorId: 'd' } as never);
      bookingContext.patchSelection.mockResolvedValue({ language: 'ar' } as never);
      const ar = await call('select_clinic', { clinicId: UUID }, GUEST);
      expect(ar.branchAutoSelected).toBe(false);
      expect(ar.reselectionGuidance).toContain('بما أنك اخترت عيادة جديدة');
      bookingContext.patchSelection.mockResolvedValue({ language: 'en' } as never);
      expect((await call('select_clinic', { clinicId: UUID }, GUEST)).reselectionGuidance).toContain('Since you switched clinics');
    });

    it('select_branch refuses a branch of another clinic, else records it with the cascade reset', async () => {
      const { call, bookingContext } = build();
      bookingContext.resolveTenantFromBranch.mockResolvedValue('clinic-A');
      bookingContext.getSelection.mockResolvedValue({ selectedClinicId: 'clinic-B' } as never);
      expect(await call('select_branch', { branchId: UUID }, GUEST)).toEqual({ success: false, error: 'That branch does not belong to the selected clinic.' });
      bookingContext.getSelection.mockResolvedValue({ selectedClinicId: 'clinic-A' } as never);
      expect(await call('select_branch', { branchId: UUID }, GUEST)).toEqual({ success: true, branchId: UUID });
      expect(bookingContext.patchSelection).toHaveBeenLastCalledWith('t1', 'c1', {
        selectedClinicId: 'clinic-A', selectedBranchId: UUID,
        selectedDoctorId: SESSION_UNSET, selectedServiceIds: SESSION_UNSET, selectedStartAt: SESSION_UNSET,
      });
    });

    it('list_branch_services marks an unpublished price as NOT_PUBLISHED, never free', async () => {
      const { call, discovery, bookingContext } = build();
      bookingContext.requireContext.mockResolvedValue({ tenantId: 'clinic', branchId: 'b1' });
      discovery.listBranchServices.mockResolvedValue([{ id: 's1', price: null }, { id: 's2', price: 0 }]);
      const r = await call('list_branch_services', {}, GUEST);
      expect(r.services.map((s: any) => s.priceStatus)).toEqual(['NOT_PUBLISHED', 'PUBLISHED']);
      expect(r.guidance).toContain('NEVER call it free');
      expect(bookingContext.requireContext).toHaveBeenCalledWith('t1', 'c1', GUEST.principal, 'branch');
    });

    it('select_service rejects unknown services and malformed ids, else records them', async () => {
      const { call, discovery, bookingContext } = build();
      bookingContext.requireContext.mockResolvedValue({ tenantId: 'clinic', branchId: 'b1' });
      discovery.listBranchServices.mockResolvedValue([{ id: UUID }]);
      expect((await call('select_service', { serviceIds: ['x'] }, GUEST)).error).toContain('Every serviceIds entry must be the UUID');
      expect(await call('select_service', { serviceIds: [UUID2] }, GUEST)).toMatchObject({
        success: false, rejectedServiceIds: [UUID2],
      });
      expect(await call('select_service', { serviceIds: [UUID] }, GUEST)).toEqual({ success: true, services: [{ id: UUID }] });
      expect(bookingContext.patchSelection).toHaveBeenLastCalledWith('t1', 'c1', { selectedServiceIds: [UUID] });
    });

    it('select_doctor accepts only a doctor of the branch and clears the chosen time', async () => {
      const { call, discovery, bookingContext } = build();
      bookingContext.requireContext.mockResolvedValue({ tenantId: 'clinic', branchId: 'b1' });
      discovery.listBranchDoctors.mockResolvedValue([{ id: UUID }]);
      expect(await call('select_doctor', { staffId: UUID2 }, GUEST)).toEqual({ success: false, error: 'That doctor does not work at the selected branch.' });
      expect(await call('select_doctor', { staffId: UUID }, GUEST)).toEqual({ success: true, staffId: UUID });
      expect(bookingContext.patchSelection).toHaveBeenLastCalledWith('t1', 'c1', { selectedDoctorId: UUID, selectedStartAt: SESSION_UNSET });
    });

    it('select_slot needs a strict ISO instant and a chosen doctor', async () => {
      const { call, bookingContext } = build();
      expect((await call('select_slot', { startAt: 'five pm' }, GUEST)).error).toContain('startAt must be the ISO-8601 timestamp exactly as returned');
      bookingContext.requireContext.mockResolvedValue({ tenantId: 'clinic', branchId: 'b1' });
      const iso = '2026-11-02T09:00:00.000Z';
      expect(await call('select_slot', { startAt: iso }, GUEST)).toEqual({ success: true, startAt: iso });
      expect(bookingContext.requireContext).toHaveBeenLastCalledWith('t1', 'c1', GUEST.principal, 'doctor');
    });

    it('book_public_appointment needs name and phone before anything else', async () => {
      const { call, bookingContext } = build();
      expect(await call('book_public_appointment', { fullName: 'A' }, GUEST)).toEqual({
        success: false, error: 'fullName and phone are required to book.',
      });
      expect(bookingContext.requireContext).not.toHaveBeenCalled();
    });

    it('records every public session-state call, success or refusal, under the attempt namespace', async () => {
      const { call, discovery, attempts } = build();
      await call('select_clinic', { clinicId: 'name' }, GUEST);
      discovery.clinicDetail.mockResolvedValue({ clinic: {}, branches: [] });
      await call('select_clinic', { clinicId: UUID }, GUEST);
      expect(attempts.map((a) => a[5])).toEqual(['REFUSED', 'SUCCEEDED']);
    });
  });
});
