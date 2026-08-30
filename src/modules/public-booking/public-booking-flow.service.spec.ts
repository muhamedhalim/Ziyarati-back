import { PublicBookingFlowService } from './public-booking-flow.service';

/**
 * Spec 014 (Clinic Platform Completion) — T066/T067 unit coverage for the
 * deterministic (non-AI) booking flow orchestrator. Every collaborator is
 * faked at the seam `PublicBookingFlowService` actually calls — this proves
 * ITS OWN validation/wiring, not the collaborators' behaviour (those are
 * covered by their own specs: `payment-link.service.createIfDue.spec.ts`,
 * `public-booking-context.ensure-conversation.spec.ts`).
 */

const TENANT = 'clinic-a';
const CONV = 'conv-1';
const PRINCIPAL = {
  id: 'guest-1',
  tenantId: '__guest__',
  roles: [],
  permissions: [],
  guest: true as const,
};

function build(overrides: Partial<Record<string, unknown>> = {}) {
  const bookingContext = {
    getSelection: jest.fn(),
    patchSelection: jest.fn().mockResolvedValue(undefined),
    resolveTenantFromBranch: jest.fn().mockResolvedValue(TENANT),
    requireContext: jest.fn(),
  };
  const discovery = {
    clinicDetail: jest.fn(),
    listBranchServices: jest.fn(),
    listBranchDoctors: jest.fn(),
  };
  const availabilityService = { publicWindows: jest.fn() };
  const customers = { findOrCreateForBooking: jest.fn() };
  const appointments = { create: jest.fn() };
  const paymentLinks = { createIfDue: jest.fn() };
  const botActor = {
    ensureBotActor: jest.fn().mockResolvedValue({ id: 'bot-1' }),
  };
  const tenantContext = {
    run: jest.fn((fn: () => unknown) => fn()),
    setPrincipal: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const deps = {
    bookingContext,
    discovery,
    availabilityService,
    customers,
    appointments,
    paymentLinks,
    botActor,
    tenantContext,
    audit,
    ...overrides,
  };

  const service = new PublicBookingFlowService(
    deps.bookingContext as never,
    deps.discovery as never,
    deps.availabilityService as never,
    deps.customers as never,
    deps.appointments as never,
    deps.paymentLinks as never,
    deps.botActor as never,
    deps.tenantContext as never,
    deps.audit as never,
  );

  return { service, ...deps };
}

describe('PublicBookingFlowService.selectClinic', () => {
  it('auto-selects the branch when the clinic has exactly one', async () => {
    const { service, discovery, bookingContext } = build();
    discovery.clinicDetail.mockResolvedValue({
      branches: [{ id: 'branch-1' }],
    });

    await service.selectClinic(TENANT, CONV, PRINCIPAL, 'clinic-a');

    expect(bookingContext.patchSelection).toHaveBeenCalledWith(TENANT, CONV, {
      selectedClinicId: 'clinic-a',
      selectedBranchId: 'branch-1',
      selectedDoctorId: undefined,
      selectedServiceIds: undefined,
      selectedStartAt: undefined,
    });
  });

  it('leaves the branch unset when the clinic has more than one', async () => {
    const { service, discovery, bookingContext } = build();
    discovery.clinicDetail.mockResolvedValue({
      branches: [{ id: 'branch-1' }, { id: 'branch-2' }],
    });

    await service.selectClinic(TENANT, CONV, PRINCIPAL, 'clinic-a');

    expect(bookingContext.patchSelection).toHaveBeenCalledWith(
      TENANT,
      CONV,
      expect.objectContaining({ selectedBranchId: undefined }),
    );
  });

  it('rejects an unknown or ineligible clinic id as NOT_FOUND, uniformly', async () => {
    const { service, discovery } = build();
    discovery.clinicDetail.mockRejectedValue(new Error('does not exist'));

    await expect(
      service.selectClinic(TENANT, CONV, PRINCIPAL, 'nope'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PublicBookingFlowService.selectBranch', () => {
  it('rejects a branch whose real owner disagrees with an already-selected clinic', async () => {
    const { service, bookingContext } = build();
    bookingContext.resolveTenantFromBranch.mockResolvedValue('clinic-b');
    bookingContext.getSelection.mockResolvedValue({
      selectedClinicId: 'clinic-a',
    });

    await expect(
      service.selectBranch(TENANT, CONV, PRINCIPAL, 'branch-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('records the resolved owner and resets downstream selections', async () => {
    const { service, bookingContext } = build();
    bookingContext.resolveTenantFromBranch.mockResolvedValue('clinic-a');
    bookingContext.getSelection.mockResolvedValue({
      selectedClinicId: undefined,
    });

    await service.selectBranch(TENANT, CONV, PRINCIPAL, 'branch-1');

    expect(bookingContext.patchSelection).toHaveBeenCalledWith(TENANT, CONV, {
      selectedClinicId: 'clinic-a',
      selectedBranchId: 'branch-1',
      selectedDoctorId: undefined,
      selectedServiceIds: undefined,
      selectedStartAt: undefined,
    });
  });
});

describe('PublicBookingFlowService.selectService', () => {
  it('rejects an empty selection', async () => {
    const { service } = build();
    await expect(
      service.selectService(TENANT, CONV, PRINCIPAL, []),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
  });

  it('rejects a service not offered at the selected branch', async () => {
    const { service, bookingContext, discovery } = build();
    bookingContext.requireContext.mockResolvedValue({
      tenantId: TENANT,
      branchId: 'branch-1',
    });
    discovery.listBranchServices.mockResolvedValue([{ id: 'svc-1' }]);

    await expect(
      service.selectService(TENANT, CONV, PRINCIPAL, ['svc-not-offered']),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
  });

  it('accepts every id that is offered and resets doctor/slot', async () => {
    const { service, bookingContext, discovery } = build();
    bookingContext.requireContext.mockResolvedValue({
      tenantId: TENANT,
      branchId: 'branch-1',
    });
    discovery.listBranchServices.mockResolvedValue([
      { id: 'svc-1' },
      { id: 'svc-2' },
    ]);

    await service.selectService(TENANT, CONV, PRINCIPAL, ['svc-1', 'svc-2']);

    expect(bookingContext.patchSelection).toHaveBeenCalledWith(TENANT, CONV, {
      selectedServiceIds: ['svc-1', 'svc-2'],
      selectedDoctorId: undefined,
      selectedStartAt: undefined,
    });
  });
});

describe('PublicBookingFlowService.selectDoctor', () => {
  it('rejects a doctor who does not work at the selected branch — the SAME predicate the AI flow uses', async () => {
    const { service, bookingContext, discovery } = build();
    bookingContext.requireContext.mockResolvedValue({
      tenantId: TENANT,
      branchId: 'branch-1',
      serviceIds: ['svc-1'],
    });
    discovery.listBranchDoctors.mockResolvedValue([{ id: 'doc-2' }]);

    await expect(
      service.selectDoctor(TENANT, CONV, PRINCIPAL, 'doc-1'),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
    expect(discovery.listBranchDoctors).toHaveBeenCalledWith(
      TENANT,
      'branch-1',
    );
  });

  it('accepts an eligible doctor and resets the slot', async () => {
    const { service, bookingContext, discovery } = build();
    bookingContext.requireContext.mockResolvedValue({
      tenantId: TENANT,
      branchId: 'branch-1',
      serviceIds: ['svc-1'],
    });
    discovery.listBranchDoctors.mockResolvedValue([{ id: 'doc-1' }]);

    await service.selectDoctor(TENANT, CONV, PRINCIPAL, 'doc-1');

    expect(bookingContext.patchSelection).toHaveBeenCalledWith(TENANT, CONV, {
      selectedDoctorId: 'doc-1',
      selectedStartAt: undefined,
    });
  });
});

describe('PublicBookingFlowService.availability', () => {
  it('sums the selected services duration into the requested slot size', async () => {
    const { service, bookingContext, discovery, availabilityService } = build();
    bookingContext.requireContext.mockResolvedValue({
      tenantId: TENANT,
      branchId: 'branch-1',
      staffId: 'doc-1',
      serviceIds: ['svc-1', 'svc-2'],
    });
    discovery.listBranchServices.mockResolvedValue([
      { id: 'svc-1', durationMinutes: 15 },
      { id: 'svc-2', durationMinutes: 20 },
      { id: 'svc-3', durationMinutes: 99 },
    ]);
    availabilityService.publicWindows.mockResolvedValue({
      timezone: 'Asia/Riyadh',
      windows: [{ startAt: '2026-09-01T09:00:00Z' }],
    });

    const result = await service.availability(
      TENANT,
      CONV,
      PRINCIPAL,
      '2026-09-01',
      '2026-09-02',
    );

    expect(availabilityService.publicWindows).toHaveBeenCalledWith(TENANT, {
      branchId: 'branch-1',
      staffId: 'doc-1',
      fromDate: '2026-09-01',
      toDate: '2026-09-02',
      slotMinutes: 35,
    });
    expect(result).toEqual({
      timezone: 'Asia/Riyadh',
      slots: [{ startAt: '2026-09-01T09:00:00Z' }],
    });
  });
});

describe('PublicBookingFlowService.selectSlot', () => {
  it('rejects a non-ISO timestamp', async () => {
    const { service } = build();
    await expect(
      service.selectSlot(TENANT, CONV, PRINCIPAL, 'not-a-date'),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
  });

  it('records a valid timestamp', async () => {
    const { service, bookingContext } = build();
    bookingContext.requireContext.mockResolvedValue({
      tenantId: TENANT,
      branchId: 'branch-1',
    });

    await service.selectSlot(
      TENANT,
      CONV,
      PRINCIPAL,
      '2026-09-01T09:00:00.000Z',
    );

    expect(bookingContext.patchSelection).toHaveBeenCalledWith(TENANT, CONV, {
      selectedStartAt: '2026-09-01T09:00:00.000Z',
    });
  });
});

describe('PublicBookingFlowService.confirm', () => {
  const CTX = {
    tenantId: TENANT,
    branchId: 'branch-1',
    staffId: 'doc-1',
    startAt: '2026-09-01T09:00:00.000Z',
    serviceIds: ['svc-1'],
  };
  const APPT = {
    id: 'appt-1',
    status: 'CONFIRMED',
    payment_status: 'PENDING',
    start_at: new Date('2026-09-01T09:00:00.000Z'),
    end_at: new Date('2026-09-01T09:20:00.000Z'),
    total_amount: 100,
    currency: 'SAR',
  };

  it('runs the write under the clinic bot actor, inside that tenant context', async () => {
    const {
      service,
      bookingContext,
      customers,
      appointments,
      botActor,
      tenantContext,
      paymentLinks,
      audit,
    } = build();
    bookingContext.requireContext.mockResolvedValue(CTX);
    customers.findOrCreateForBooking.mockResolvedValue({ id: 'cust-1' });
    appointments.create.mockResolvedValue(APPT);
    paymentLinks.createIfDue.mockResolvedValue({
      token: 'pl-token',
      amount: 100,
      currency: 'SAR',
    });

    const result = await service.confirm(TENANT, CONV, PRINCIPAL, {
      fullName: 'Visitor',
      phone: '+966500000000',
    });

    expect(botActor.ensureBotActor).toHaveBeenCalledWith(TENANT);
    expect(tenantContext.run).toHaveBeenCalled();
    expect(tenantContext.setPrincipal).toHaveBeenCalledWith({ id: 'bot-1' });
    expect(appointments.create).toHaveBeenCalledWith(
      TENANT,
      'bot-1',
      expect.objectContaining({
        branchId: 'branch-1',
        customerId: 'cust-1',
        staffId: 'doc-1',
        startAt: CTX.startAt,
        serviceIds: ['svc-1'],
        hasInsurance: false,
      }),
    );
    expect(bookingContext.patchSelection).toHaveBeenCalledWith(TENANT, CONV, {
      bookingCustomerId: 'cust-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      'appointment.booked_publicly',
      TENANT,
      'appt-1',
      expect.objectContaining({ hasInsurance: false }),
    );
    expect(result).toMatchObject({
      appointmentId: 'appt-1',
      hasInsurance: false,
      paymentLink: { token: 'pl-token', amount: 100, currency: 'SAR' },
    });
  });

  it('skips the payment link entirely when the visitor declared insurance', async () => {
    const { service, bookingContext, customers, appointments, paymentLinks } =
      build();
    bookingContext.requireContext.mockResolvedValue(CTX);
    customers.findOrCreateForBooking.mockResolvedValue({ id: 'cust-1' });
    appointments.create.mockResolvedValue({
      ...APPT,
      payment_status: 'INSURANCE',
    });

    const result = await service.confirm(TENANT, CONV, PRINCIPAL, {
      fullName: 'Visitor',
      phone: '+966500000000',
      hasInsurance: true,
    });

    expect(paymentLinks.createIfDue).not.toHaveBeenCalled();
    expect(appointments.create).toHaveBeenCalledWith(
      TENANT,
      'bot-1',
      expect.objectContaining({ hasInsurance: true }),
    );
    expect(result.paymentLink).toBeUndefined();
    expect(result.hasInsurance).toBe(true);
  });
});
