import { AiToolDispatchService } from './ai-tool-dispatch.service';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
} from '../../../entities/enums';

const TENANT = 'tenant-1';

const ctx = {
  tenantId: TENANT,
  actorUserId: 'user-1',
  permissions: ['appointments.create'],
  customerId: 'cust-1',
  aiConversationId: 'conv-1',
};

const baseArgs = {
  branchId: 'b1',
  customerId: 'cust-1',
  staffId: 's1',
  startAt: '2026-08-10T10:00:00.000Z',
};

function buildAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appt-1',
    status: AppointmentStatus.PENDING_PAYMENT,
    payment_status: AppointmentPaymentStatus.UNPAID,
    total_amount: 200,
    currency: 'SAR',
    start_at: new Date('2026-08-10T10:00:00Z'),
    end_at: new Date('2026-08-10T10:30:00Z'),
    ...overrides,
  };
}

/** One `run()` invocation makes exactly 4 dataSource.query calls: findByKey
 *  (no existing row) → claim INSERT → EXECUTING update → SUCCEEDED update. */
function buildDataSourceMock() {
  return {
    query: jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'toolcall-1' }])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined),
  };
}

interface BuildOverrides {
  appointmentsCreate?: jest.Mock;
  customerFindOneOrThrow?: jest.Mock;
  customerSetInsurance?: jest.Mock;
  tenantsGetSettings?: jest.Mock;
  paymentLinksCreate?: jest.Mock;
}

function buildService(overrides: BuildOverrides = {}) {
  const appointments = {
    create:
      overrides.appointmentsCreate ??
      jest.fn().mockResolvedValue(buildAppointment()),
  };
  const customers = {
    findOneOrThrow:
      overrides.customerFindOneOrThrow ??
      jest.fn().mockResolvedValue({ id: 'cust-1', has_health_insurance: null }),
    setInsuranceStatus:
      overrides.customerSetInsurance ?? jest.fn().mockResolvedValue(undefined),
  };
  const tenants = {
    getSettings:
      overrides.tenantsGetSettings ??
      jest.fn().mockResolvedValue({ payment_required: true }),
  };
  const paymentLinks = {
    create:
      overrides.paymentLinksCreate ??
      jest.fn().mockResolvedValue({
        link_token: 'tok_abc',
        amount: 200,
        expires_at: new Date('2026-08-13T00:00:00Z'),
      }),
  };
  const dataSource = buildDataSourceMock();
  // AI-016/AI-017 (T072/T073): writeAttemptRow/run() now call
  // this.tenantContext.getCorrelationId(), so this can no longer be `{}`.
  const tenantContext = {
    getCorrelationId: jest.fn().mockReturnValue(null),
  };

  const service = new AiToolDispatchService(
    appointments as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    customers as any,
    {} as any,
    {} as any,
    dataSource as any,
    {} as any,
    tenants as any,
    paymentLinks as any,
    {} as any,
    {} as any,
    tenantContext as any,
    {} as any,
  );

  return {
    service,
    appointments,
    customers,
    tenants,
    paymentLinks,
    dataSource,
  };
}

describe('AiToolDispatchService — insurance-aware booking', () => {
  it('books normally and auto-generates a payment link when uninsured and payment is required', async () => {
    const { service, appointments, paymentLinks } = buildService();

    const result: any = await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify({ ...baseArgs, hasInsurance: false }),
    });

    expect(appointments.create).toHaveBeenCalledWith(
      TENANT,
      'user-1',
      expect.objectContaining({ hasInsurance: false }),
    );
    expect(paymentLinks.create).toHaveBeenCalledWith(TENANT, {
      appointmentId: 'appt-1',
      amount: 200,
    });
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        hasInsurance: false,
        paymentLink: expect.objectContaining({ token: 'tok_abc' }),
      }),
    );
  });

  it('books without a payment link when insured, even though the clinic requires payment', async () => {
    const { service, appointments, paymentLinks } = buildService();

    const result: any = await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify({ ...baseArgs, hasInsurance: true }),
    });

    expect(appointments.create).toHaveBeenCalledWith(
      TENANT,
      'user-1',
      expect.objectContaining({ hasInsurance: true }),
    );
    expect(paymentLinks.create).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ success: true, hasInsurance: true }),
    );
    expect(result.paymentLink).toBeUndefined();
  });

  it('skips the payment link when the clinic does not require online payment', async () => {
    const { service, paymentLinks } = buildService({
      tenantsGetSettings: jest
        .fn()
        .mockResolvedValue({ payment_required: false }),
    });

    const result: any = await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify({ ...baseArgs, hasInsurance: false }),
    });

    expect(paymentLinks.create).not.toHaveBeenCalled();
    expect(result.paymentLink).toBeUndefined();
  });

  it('falls back to the on-file insurance value when the model omits hasInsurance', async () => {
    const { service, appointments, paymentLinks } = buildService({
      customerFindOneOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'cust-1', has_health_insurance: true }),
    });

    await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify(baseArgs),
    });

    expect(appointments.create).toHaveBeenCalledWith(
      TENANT,
      'user-1',
      expect.objectContaining({ hasInsurance: true }),
    );
    expect(paymentLinks.create).not.toHaveBeenCalled();
  });

  it('defaults to "no insurance" (existing behavior, safe default) when never asked and omitted', async () => {
    const { service, appointments } = buildService({
      customerFindOneOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'cust-1', has_health_insurance: null }),
    });

    await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify(baseArgs),
    });

    expect(appointments.create).toHaveBeenCalledWith(
      TENANT,
      'user-1',
      expect.objectContaining({ hasInsurance: false }),
    );
  });

  it('persists a newly-confirmed insurance answer onto the customer record', async () => {
    const { service, customers } = buildService({
      customerFindOneOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'cust-1', has_health_insurance: null }),
    });

    await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify({ ...baseArgs, hasInsurance: true }),
    });

    expect(customers.setInsuranceStatus).toHaveBeenCalledWith(
      TENANT,
      'cust-1',
      true,
    );
  });

  it('does not re-write the customer record when the confirmed answer matches what is on file', async () => {
    const { service, customers } = buildService({
      customerFindOneOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'cust-1', has_health_insurance: true }),
    });

    await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify({ ...baseArgs, hasInsurance: true }),
    });

    expect(customers.setInsuranceStatus).not.toHaveBeenCalled();
  });

  it('never blocks the booking when payment-link generation fails (e.g. clinic not payment-approved)', async () => {
    const { service, appointments } = buildService({
      paymentLinksCreate: jest
        .fn()
        .mockRejectedValue(new Error('clinic not chargeable')),
    });

    const result: any = await service.execute(ctx as any, {
      id: 'call-1',
      name: 'book_appointment',
      arguments: JSON.stringify({ ...baseArgs, hasInsurance: false }),
    });

    expect(appointments.create).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.paymentLink).toBeUndefined();
  });
});

describe('AiToolDispatchService — get_customer_insurance_status', () => {
  it('returns the on-file value and known=true when previously answered', async () => {
    const { service } = buildService({
      customerFindOneOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'cust-1', has_health_insurance: false }),
    });

    const result: any = await service.execute(ctx as any, {
      id: 'call-1',
      name: 'get_customer_insurance_status',
      arguments: JSON.stringify({}),
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        hasInsurance: false,
        known: true,
      }),
    );
  });

  it('returns null and known=false when never asked', async () => {
    const { service } = buildService({
      customerFindOneOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'cust-1', has_health_insurance: null }),
    });

    const result: any = await service.execute(ctx as any, {
      id: 'call-1',
      name: 'get_customer_insurance_status',
      arguments: JSON.stringify({}),
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        hasInsurance: null,
        known: false,
      }),
    );
  });

  // AI-003: an id the model supplies (not server-bound) needs a real
  // customers.read permission, or one call per known id enumerates the
  // tenant's whole insurance-status roster.
  it('refuses an unbound customerId supplied only in args when the principal lacks customers.read', async () => {
    const { service, customers } = buildService();
    const unboundCtx = { ...ctx, customerId: undefined, permissions: ['dashboard.access'] };

    const result: any = await service.execute(unboundCtx as any, {
      id: 'call-1',
      name: 'get_customer_insurance_status',
      arguments: JSON.stringify({ customerId: 'cust-2' }),
    });

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(customers.findOneOrThrow).not.toHaveBeenCalled();
  });

  it('allows an unbound customerId supplied in args when the principal HAS customers.read', async () => {
    const { service, customers } = buildService({
      customerFindOneOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'cust-2', has_health_insurance: true }),
    });
    const unboundCtx = { ...ctx, customerId: undefined, permissions: ['customers.read'] };

    const result: any = await service.execute(unboundCtx as any, {
      id: 'call-1',
      name: 'get_customer_insurance_status',
      arguments: JSON.stringify({ customerId: 'cust-2' }),
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, hasInsurance: true, known: true }),
    );
    expect(customers.findOneOrThrow).toHaveBeenCalledWith(TENANT, 'cust-2');
  });
});
