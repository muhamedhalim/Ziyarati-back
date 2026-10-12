import { IntegrationUpsertService } from './integration-upsert.service';
import { viewFingerprint } from './source-of-truth';
import {
  CONFLICT_POLICY,
  CONFLICT_REASON,
  INTEGRATION_RESOURCE,
  UPSERT_LIFECYCLE,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';
import { AppError, ErrorCode } from '../../../common/errors';

const TENANT = 't-1';
const CONN = 'c-1';
const USER = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: USER };
const APPT = INTEGRATION_RESOURCE.APPOINTMENT;
const CUSTOMER = INTEGRATION_RESOURCE.CUSTOMER;

/** DB row for an existing appointment: 07:00Z–07:30Z, one service. */
const apptRow = (over: Record<string, unknown> = {}) => ({
  id: 'ap-1',
  start_at: new Date('2026-10-28T07:00:00.000Z'),
  end_at: new Date('2026-10-28T07:30:00.000Z'),
  staff: { id: 'st-1' },
  customer: { id: 'cu-1' },
  branch: { id: 'br-1' },
  services: [{ service: { id: 'sv-1' } }],
  notes: null,
  ...over,
});

const sameAppt = {
  startAt: '2026-10-28T10:00:00+03:00', // == 07:00Z
  branchId: 'br-1',
  staffId: 'st-1',
  customerId: 'cu-1',
  serviceIds: ['sv-1'],
};

function build(opts: {
  mapping?: Record<string, unknown> | null;
  appt?: Record<string, unknown> | null;
  customer?: Record<string, unknown> | null;
  extraMaps?: Record<string, string>;
} = {}) {
  const idMap = {
    findByExternalId: jest.fn(async (_t: string, _c: string, resource: string, ext: string) => {
      if (resource === APPT && ext === 'EXT-A') return opts.mapping ?? null;
      if (resource === CUSTOMER && ext === 'EXT-C') return opts.mapping ?? null;
      const m = opts.extraMaps?.[`${resource}:${ext}`];
      return m ? { id: 'm', internal_resource_id: m } : null;
    }),
    link: jest.fn().mockResolvedValue({ id: 'map-new' }),
    recordBaseline: jest.fn().mockResolvedValue(undefined),
  };
  const appointmentRepo = { findOne: jest.fn().mockResolvedValue(opts.appt ?? null) };
  const customerRepo = { findOne: jest.fn().mockResolvedValue(opts.customer ?? null) };
  const appointmentsSvc = {
    create: jest.fn().mockResolvedValue({ id: 'ap-new' }),
    cancel: jest.fn().mockResolvedValue(undefined),
    reschedule: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    setServices: jest.fn().mockResolvedValue(undefined),
  };
  const customers = {
    create: jest.fn().mockResolvedValue({ id: 'cu-new' }),
    update: jest.fn().mockResolvedValue({ id: 'cu-1' }),
  };
  const conflicts = { record: jest.fn().mockResolvedValue(null) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new IntegrationUpsertService(
    customers as never,
    {} as never,
    {} as never,
    appointmentsSvc as never,
    customerRepo as never,
    {} as never,
    {} as never,
    appointmentRepo as never,
    idMap as never,
    {} as never,
    audit as never,
    conflicts as never,
  );
  return { svc, idMap, appointmentsSvc, customers, conflicts, appointmentRepo, customerRepo };
}

const mapped = (extra: Record<string, unknown> = {}) => ({
  id: 'map-1',
  internal_resource_id: 'ap-1',
  last_synced_hash: null,
  ...extra,
});

describe('F02 — lifecycle comes from the authorised event type, never from the payload', () => {
  it('appointment.created for a mapped appointment with data.action="cancel" does NOT cancel (identical → skipped)', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    const r = await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.EXTERNAL_WINS, 'EXT-A',
      { ...sameAppt, action: 'cancel', reason: 'smuggled' }, ACTOR,
      { safe: false, lifecycle: UPSERT_LIFECYCLE.CREATE },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.SKIPPED);
    expect(t.appointmentsSvc.cancel).not.toHaveBeenCalled();
    expect(t.appointmentsSvc.reschedule).not.toHaveBeenCalled();
  });

  it('appointment.created with action="reschedule" and a different time does NOT move the appointment (review item, not applied)', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    const r = await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.EXTERNAL_WINS, 'EXT-A',
      { ...sameAppt, startAt: '2026-10-28T11:00:00+03:00', action: 'reschedule' }, ACTOR,
      { safe: false, lifecycle: UPSERT_LIFECYCLE.CREATE },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.CONFLICTED);
    expect(r.reason).toBe(CONFLICT_REASON.LIFECYCLE_NOT_ALLOWED);
    expect(t.appointmentsSvc.reschedule).not.toHaveBeenCalled();
    expect(t.appointmentsSvc.cancel).not.toHaveBeenCalled();
    expect(t.conflicts.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: CONFLICT_REASON.LIFECYCLE_NOT_ALLOWED, internalId: 'ap-1' }),
    );
  });

  it('a changed startAt on a "created" event is refused even under external_wins', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.EXTERNAL_WINS, 'EXT-A',
      { ...sameAppt, startAt: '2026-10-29T10:00:00+03:00' }, ACTOR,
      { safe: false, lifecycle: UPSERT_LIFECYCLE.CREATE },
    );
    expect(t.appointmentsSvc.reschedule).not.toHaveBeenCalled();
  });

  it('appointment.cancelled cancels, regardless of any action in the payload', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    const r = await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-A',
      { reason: 'patient asked', action: 'reschedule' }, ACTOR,
      { safe: false, lifecycle: UPSERT_LIFECYCLE.CANCEL },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.UPDATED);
    expect(t.appointmentsSvc.cancel).toHaveBeenCalledWith(TENANT, USER, 'ap-1', { reason: 'patient asked' });
    expect(t.appointmentsSvc.reschedule).not.toHaveBeenCalled();
  });

  it('appointment.rescheduled reschedules and never cancels, even with action="cancel" in the payload', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-A',
      { startAt: '2026-10-28T11:00:00+03:00', action: 'cancel' }, ACTOR,
      { safe: false, lifecycle: UPSERT_LIFECYCLE.RESCHEDULE },
    );
    expect(t.appointmentsSvc.cancel).not.toHaveBeenCalled();
    expect(t.appointmentsSvc.reschedule).toHaveBeenCalledWith(
      TENANT, USER, 'ap-1',
      expect.objectContaining({ newStartAt: '2026-10-28T08:00:00.000Z' }),
    );
  });

  it.each([UPSERT_LIFECYCLE.CANCEL, UPSERT_LIFECYCLE.RESCHEDULE])(
    '%s for an unmapped external id is refused — it never creates an appointment',
    async (lifecycle) => {
      const t = build({ mapping: null });
      const r = await t.svc.upsertOne(
        TENANT, APPT, CONN, CONFLICT_POLICY.EXTERNAL_WINS, 'EXT-NEW', { ...sameAppt }, ACTOR,
        { safe: false, lifecycle },
      );
      expect(r.outcome).toBe(UPSERT_OUTCOME.CONFLICTED);
      expect(r.reason).toBe(CONFLICT_REASON.LIFECYCLE_NOT_ALLOWED);
      expect(t.appointmentsSvc.create).not.toHaveBeenCalled();
    },
  );

  it('the API-key route (no explicit lifecycle) still honours the documented data.action hint', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-A',
      { action: 'cancel', reason: 'r' }, ACTOR, { safe: false },
    );
    expect(t.appointmentsSvc.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('F01 — default policy applies a partner update only when the clinic has not touched the record', () => {
  const view = {
    full_name: 'Amal',
    phone: '+966500000001',
    email: null,
    gender: null,
    date_of_birth: null,
    source: null,
    marketing_opt_in: false,
    is_active: true,
  };
  const row = () => ({ id: 'cu-1', ...view });
  const cmap = (hash: string | null) => ({ id: 'map-c', internal_resource_id: 'cu-1', last_synced_hash: hash });

  it('baseline matches → the update is APPLIED and the baseline moves forward', async () => {
    const t = build({ mapping: cmap(viewFingerprint(view)), customer: row() });
    const r = await t.svc.upsertOne(
      TENANT, CUSTOMER, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-C',
      { full_name: 'Amal Khan' }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.UPDATED);
    expect(r.changedFields).toEqual(['full_name']);
    expect(t.customers.update).toHaveBeenCalledTimes(1);
    expect(t.idMap.recordBaseline).toHaveBeenCalledWith('map-c', expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it('the clinic edited the record since (baseline mismatch) → conflicted, nothing applied, review item queued', async () => {
    const t = build({ mapping: cmap(viewFingerprint({ ...view, phone: '+966500000009' })), customer: row() });
    const r = await t.svc.upsertOne(
      TENANT, CUSTOMER, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-C',
      { full_name: 'Amal Khan' }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.CONFLICTED);
    expect(r.reason).toBe(CONFLICT_REASON.FIELD_DIVERGENCE);
    expect(t.customers.update).not.toHaveBeenCalled();
    expect(t.conflicts.record).toHaveBeenCalledTimes(1);
  });

  it('a legacy mapping without a baseline stays conservative (conflicted)', async () => {
    const t = build({ mapping: cmap(null), customer: row() });
    const r = await t.svc.upsertOne(
      TENANT, CUSTOMER, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-C',
      { full_name: 'Amal Khan' }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.CONFLICTED);
    expect(t.customers.update).not.toHaveBeenCalled();
  });

  it('an identical resend establishes the baseline for a legacy mapping', async () => {
    const t = build({ mapping: cmap(null), customer: row() });
    const r = await t.svc.upsertOne(
      TENANT, CUSTOMER, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-C',
      { full_name: 'Amal' }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.SKIPPED);
    expect(t.idMap.recordBaseline).toHaveBeenCalledWith('map-c', viewFingerprint(view));
  });

  it('external_wins applies regardless; platform_wins keeps the platform record', async () => {
    const stale = cmap(viewFingerprint({ ...view, phone: '+966500000009' }));
    const ew = build({ mapping: stale, customer: row() });
    expect(
      (await ew.svc.upsertOne(TENANT, CUSTOMER, CONN, CONFLICT_POLICY.EXTERNAL_WINS, 'EXT-C', { full_name: 'Z' }, ACTOR, { safe: false })).outcome,
    ).toBe(UPSERT_OUTCOME.UPDATED);
    const pw = build({ mapping: cmap(viewFingerprint(view)), customer: row() });
    expect(
      (await pw.svc.upsertOne(TENANT, CUSTOMER, CONN, CONFLICT_POLICY.PLATFORM_WINS, 'EXT-C', { full_name: 'Z' }, ACTOR, { safe: false })).outcome,
    ).toBe(UPSERT_OUTCOME.SKIPPED);
  });

  it('a successful create records the baseline so the next update is applied', async () => {
    const t = build({ mapping: null, customer: row() });
    t.customerRepo.findOne.mockResolvedValueOnce(null).mockResolvedValue(row()); // naturalMatch none, then post-create view
    const r = await t.svc.upsertOne(
      TENANT, CUSTOMER, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-C',
      { full_name: 'Amal', phone: '+966500000001' }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.CREATED);
    expect(t.idMap.recordBaseline).toHaveBeenCalledWith('map-new', viewFingerprint(view));
  });
});

describe('F10 / F11 — timestamps and no-op detection on appointments', () => {
  it.each([
    ['no offset', '2026-10-28T10:00:00'],
    ['date only', '2026-10-28'],
    ['epoch number', 1792000000000],
    ['impossible date', '2026-02-30T10:00:00+03:00'],
  ])('rejects startAt with %s before touching anything', async (_n, startAt) => {
    const t = build({ mapping: null });
    await expect(
      t.svc.upsertOne(TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-NEW', { ...sameAppt, startAt }, ACTOR, { safe: false }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(t.idMap.findByExternalId).not.toHaveBeenCalled();
    expect(t.appointmentsSvc.create).not.toHaveBeenCalled();
  });

  it('rejects endAt that is not after startAt', async () => {
    const t = build({ mapping: null });
    await expect(
      t.svc.upsertOne(
        TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-NEW',
        { ...sameAppt, endAt: '2026-10-28T10:00:00+03:00' }, ACTOR, { safe: false },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('accepts Z, +hh:mm and -hh:mm and creates with the UTC instant', async () => {
    for (const startAt of ['2026-10-28T07:00:00Z', '2026-10-28T10:00:00+03:00', '2026-10-28T02:00:00-05:00']) {
      const t = build({ mapping: null, extraMaps: { [`${CUSTOMER}:EXT-CU`]: 'cu-1', [`staff:EXT-ST`]: 'st-1' } });
      await t.svc.upsertOne(
        TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-NEW',
        { startAt, branchId: 'br-1', serviceIds: ['sv-1'] },
        ACTOR, { safe: false },
      ).catch(() => undefined); // customer/staff hints absent → missing_dependency; we only inspect normalisation below
      // Direct normalisation check through a full create with hints:
      const t2 = build({ mapping: null, extraMaps: { [`${CUSTOMER}:EXT-CU`]: 'cu-1', 'staff:EXT-ST': 'st-1' } });
      await t2.svc.upsertOne(
        TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-NEW',
        { startAt, branchId: 'br-1', customerExternalId: 'EXT-CU', staffExternalId: 'EXT-ST', serviceIds: ['sv-1'] },
        ACTOR, { safe: false },
      );
      expect(t2.appointmentsSvc.create).toHaveBeenCalledWith(
        TENANT, USER, expect.objectContaining({ startAt: '2026-10-28T07:00:00.000Z', branchId: 'br-1' }),
      );
    }
  });

  it('F05: branchExternalId is not a thing — a missing branchId is a 422 missing_dependency', async () => {
    const t = build({ mapping: null, extraMaps: { [`${CUSTOMER}:EXT-CU`]: 'cu-1', 'staff:EXT-ST': 'st-1' } });
    await expect(
      t.svc.upsertOne(
        TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-NEW',
        { startAt: '2026-10-28T10:00:00+03:00', branchExternalId: 'PMS-B-1', customerExternalId: 'EXT-CU', staffExternalId: 'EXT-ST', serviceIds: ['sv-1'] },
        ACTOR, { safe: false },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    expect(t.appointmentsSvc.create).not.toHaveBeenCalled();
  });

  it('an identical resend is SKIPPED with no update calls', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    const r = await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-A', { ...sameAppt }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.SKIPPED);
    expect(r.changedFields).toBeUndefined();
    expect(t.appointmentsSvc.reschedule).not.toHaveBeenCalled();
    expect(t.appointmentsSvc.setServices).not.toHaveBeenCalled();
  });

  it('equivalent inputs (different offset, reordered / duplicated service ids) are SKIPPED', async () => {
    const row = apptRow({ services: [{ service: { id: 'sv-2' } }, { service: { id: 'sv-1' } }] });
    const t = build({ mapping: mapped(), appt: row });
    const r = await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-A',
      { ...sameAppt, startAt: '2026-10-28T07:00:00Z', serviceIds: ['sv-1', 'sv-2', 'sv-1'] },
      ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.SKIPPED);
  });

  it('a genuine service-set change under external_wins calls setServices (and only that)', async () => {
    const t = build({ mapping: mapped(), appt: apptRow() });
    const r = await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.EXTERNAL_WINS, 'EXT-A',
      { ...sameAppt, serviceIds: ['sv-1', 'sv-3'] }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.UPDATED);
    expect(r.changedFields).toEqual(['serviceIds']);
    expect(t.appointmentsSvc.setServices).toHaveBeenCalledWith(TENANT, USER, 'ap-1', { serviceIds: ['sv-1', 'sv-3'] });
    expect(t.appointmentsSvc.reschedule).not.toHaveBeenCalled();
  });

  it('serviceExternalIds resolve through the mapping and compare as a set', async () => {
    const t = build({
      mapping: mapped(),
      appt: apptRow(),
      extraMaps: { 'service:EXT-SV': 'sv-1' },
    });
    const { serviceIds: _omit, ...rest } = sameAppt;
    const r = await t.svc.upsertOne(
      TENANT, APPT, CONN, CONFLICT_POLICY.REJECT_AND_REPORT, 'EXT-A',
      { ...rest, serviceExternalIds: ['EXT-SV'] }, ACTOR, { safe: false },
    );
    expect(r.outcome).toBe(UPSERT_OUTCOME.SKIPPED);
  });
});
