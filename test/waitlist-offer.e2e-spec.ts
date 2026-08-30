/**
 * T154 (US9, FR-W009/FR-W011) — pins the two properties that make the
 * waitlist feature SAFE, before T157/T158 build the matching/offer engine:
 *
 *  1. FR-W009 — an outstanding offer holds NOTHING: the slot stays
 *     ordinarily bookable by anyone through the normal `/appointments`
 *     booking path the whole time an offer is outstanding. A later attempt
 *     to accept that now-stale offer fails cleanly (409, current state
 *     WITHDRAWN) rather than double-booking or erroring — and the entry
 *     returns to WAITING (FR-W011: "the loser ... MUST remain on the
 *     waitlist").
 *
 *  2. FR-W011 — two simultaneous acceptances race to exactly one
 *     appointment, in BOTH shapes the race can take:
 *       (a) two DIFFERENT waitlist entries each holding their OWN offer for
 *           the IDENTICAL freed slot (bounded top-N matching can offer one
 *           slot to several entries at once) — the loser's entry reverts to
 *           WAITING, literally;
 *       (b) the SAME offer accepted twice concurrently (a double
 *           click/replay) — the loser gets a clean 409, never a second
 *           appointment, never an unhandled error.
 *
 * Written against the FINAL contract (`POST /public/waitlist/offer/:token/
 * accept`) — red until T157/T158 exist, per this suite's own task text.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { WaitlistEntry } from '../src/entities/Calendar&Appointments/WaitlistEntry';
import { WaitlistOffer } from '../src/entities/Calendar&Appointments/WaitlistOffer';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { Service } from '../src/entities/Services/Service';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { User } from '../src/entities/Auth&RBAC/User';
import {
  AppointmentSource,
  AppointmentStatus,
  PatientActionPurpose,
  WaitlistOfferState,
  WaitlistState,
} from '../src/entities/enums';
import { PatientActionLinkService } from '../src/modules/patient-actions/patient-action-link.service';

const API = '/api/v1';
const CONCURRENCY = 5; // same rationale as patient-reschedule-concurrency.e2e-spec.ts

/** Far-future Wednesday so nothing collides with other suites; UTC branch. */
const DAY = '2032-04-14';
const WEDNESDAY = 3;

describe('Waitlist offer safety (T154, US9, FR-W009/FR-W011)', () => {
  let e2e: E2eApp;
  let links: PatientActionLinkService;
  let owner: OwnerFixture;
  let tenantId: string;
  let branchId: string;
  let staffId: string;
  let serviceId: string;
  let originatingAppointmentId: string;

  const newCustomer = async (label: string) => {
    const suffix = randomUUID().slice(0, 8);
    const customer = await e2e.dataSource.getRepository(Customer).save(
      e2e.dataSource.getRepository(Customer).create({
        tenant: { id: tenantId } as Tenant,
        full_name: `${label} ${suffix}`,
        phone: `+9665${suffix}`,
        email: `${label}-${suffix}@example.test`,
      }),
    );
    return customer.id;
  };

  const createEntry = async (customerId: string) =>
    e2e.dataSource.getRepository(WaitlistEntry).save(
      e2e.dataSource.getRepository(WaitlistEntry).create({
        tenant: { id: tenantId } as Tenant,
        customer: { id: customerId } as Customer,
        service: { id: serviceId } as Service,
        state: WaitlistState.OFFERED, // already claimed by its offer below
        priority: 0,
      }),
    );

  const createOffer = async (entryId: string, startHhmm: string) => {
    const startAt = new Date(`${DAY}T${startHhmm}:00.000Z`);
    const endAt = new Date(startAt.getTime() + 3600_000);
    const offer = await e2e.dataSource.getRepository(WaitlistOffer).save(
      e2e.dataSource.getRepository(WaitlistOffer).create({
        tenant: { id: tenantId } as Tenant,
        entry: { id: entryId } as WaitlistEntry,
        branch: { id: branchId } as Branch,
        staff: { id: staffId } as StaffProfile,
        start_at: startAt,
        end_at: endAt,
        state: WaitlistOfferState.PENDING,
        responds_by: new Date(Date.now() + 3600_000),
      }),
    );
    const appointments = await e2e.dataSource
      .getRepository(Appointment)
      .findOne({
        where: { id: originatingAppointmentId },
      });
    const token = await links.issue(
      tenantId,
      appointments!,
      PatientActionPurpose.WAITLIST_OFFER,
      offer.id,
    );
    return { offer, token, startAt, endAt };
  };

  const accept = (token: string) =>
    request(e2e.app.getHttpServer()).post(
      `${API}/public/waitlist/offer/${token}/accept`,
    );

  beforeAll(async () => {
    e2e = await createE2eApp();
    links = e2e.app.get(PatientActionLinkService);
    owner = await createOwnerFixture(e2e, 'waitlist-safety');
    tenantId = owner.tenantId;
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Waitlist Branch',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchId = branch.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `waitlist-doctor-${suffix}@example.test`,
        full_name: 'Dr Waitlist',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: 'Dr Waitlist',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    await ds.getRepository(WorkingHour).save(
      ds.getRepository(WorkingHour).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        day_of_week: WEDNESDAY,
        start_time: '08:00',
        end_time: '20:00',
        is_closed: false,
      }),
    );
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        staff: { id: staffId } as StaffProfile,
        day_of_week: WEDNESDAY,
        start_time: '08:00',
        end_time: '20:00',
        is_active: true,
      }),
    );

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Waitlist Consultation',
        duration_minutes: 60,
        base_price: 150,
        is_active: true,
      }),
    );
    serviceId = service.id;

    // Originating appointment purely to satisfy `patient_action_links
    // .appointment`'s NOT NULL FK (WaitlistOfferService's documented
    // judgment call — see its `createOffer` docblock); not read by any
    // waitlist-offer route.
    const originatorCustomerId = await newCustomer('originator');
    const originating = await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        customer: { id: originatorCustomerId } as Customer,
        staff: { id: staffId } as StaffProfile,
        start_at: new Date(`${DAY}T06:00:00.000Z`),
        end_at: new Date(`${DAY}T07:00:00.000Z`),
        status: AppointmentStatus.CANCELLED,
        source: AppointmentSource.MANUAL,
        currency: 'SAR',
      }),
    );
    originatingAppointmentId = originating.id;
  }, 120_000);

  afterAll(async () => {
    // FK-safe order: patient_action_links.waitlist_offer references
    // waitlist_offers (T155's migration — WaitlistEntriesAndOffers
    // 1730078000000), which in turn references appointments (set on
    // acceptance, no ON DELETE CASCADE — deliberate, see the entity's
    // docblock). Links first, then offers, then entries, then appointments.
    await e2e.dataSource.query(
      `DELETE FROM patient_action_links WHERE "tenantId" = $1`,
      [tenantId],
    );
    await e2e.dataSource.query(
      `DELETE FROM waitlist_offers WHERE "tenantId" = $1`,
      [tenantId],
    );
    await e2e.dataSource.query(
      `DELETE FROM waitlist_entries WHERE "tenantId" = $1`,
      [tenantId],
    );
    await e2e.dataSource.query(
      `DELETE FROM appointments WHERE "tenantId" = $1`,
      [tenantId],
    );
    await e2e.app.close();
  }, 30_000);

  it('FR-W009 — an outstanding offer does not block ordinary booking, and a later accept of the now-stale offer is refused cleanly (entry returns to WAITING)', async () => {
    const entryCustomerId = await newCustomer('holds-nothing-entry');
    const entry = await createEntry(entryCustomerId);
    const { token, startAt } = await createOffer(entry.id, '09:00');

    // The slot the offer describes is booked DIRECTLY (a different patient,
    // the ordinary path) WHILE the offer is still outstanding.
    const directCustomerId = await newCustomer('holds-nothing-direct');
    const directBooking = await request(e2e.app.getHttpServer())
      .post(`${API}/appointments`)
      .set(...authHeader(owner.token))
      .send({
        branchId,
        customerId: directCustomerId,
        staffId,
        startAt: startAt.toISOString(),
        serviceIds: [serviceId],
      });
    expect(directBooking.status).toBe(201);

    // The offer holder now tries to accept — the slot is gone.
    const res = await accept(token);
    expect(res.status).toBe(409);
    expect(res.body.context?.state).toBe(WaitlistOfferState.WITHDRAWN);

    const reloadedEntry = await e2e.dataSource
      .getRepository(WaitlistEntry)
      .findOne({ where: { id: entry.id } });
    expect(reloadedEntry?.state).toBe(WaitlistState.WAITING);

    const atSlot = await e2e.dataSource
      .getRepository(Appointment)
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.customer', 'customer')
      .where('a."tenantId" = :tenantId', { tenantId })
      .andWhere('a."staffId" = :staffId', { staffId })
      .andWhere('a.start_at = :start', { start: startAt.toISOString() })
      .getMany();
    expect(atSlot).toHaveLength(1);
    expect(atSlot[0].customer.id).toBe(directCustomerId);
  }, 30_000);

  it('FR-W011 — two DIFFERENT entries racing to accept their own offer for the SAME freed slot: exactly one appointment, the loser reverts to WAITING', async () => {
    const [customerA, customerB] = await Promise.all([
      newCustomer('sibling-race-a'),
      newCustomer('sibling-race-b'),
    ]);
    const [entryA, entryB] = await Promise.all([
      createEntry(customerA),
      createEntry(customerB),
    ]);
    const slotStart = '11:00';
    const [offerA, offerB] = await Promise.all([
      createOffer(entryA.id, slotStart),
      createOffer(entryB.id, slotStart),
    ]);

    const [resA, resB] = await Promise.all([
      accept(offerA.token),
      accept(offerB.token),
    ]);

    const results = [resA, resB];
    const successes = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const winnerIsA = resA.status === 200;
    const [winnerEntry, loserEntry] = winnerIsA
      ? [entryA, entryB]
      : [entryB, entryA];

    const [reloadedWinner, reloadedLoser] = await Promise.all([
      e2e.dataSource
        .getRepository(WaitlistEntry)
        .findOne({ where: { id: winnerEntry.id } }),
      e2e.dataSource
        .getRepository(WaitlistEntry)
        .findOne({ where: { id: loserEntry.id } }),
    ]);
    expect(reloadedWinner?.state).toBe(WaitlistState.FULFILLED);
    // The literal safety property: the loser is NOT stuck, NOT double-booked,
    // NOT errored — it is back in WAITING, eligible for the next freed slot.
    expect(reloadedLoser?.state).toBe(WaitlistState.WAITING);

    const atSlot = await e2e.dataSource
      .getRepository(Appointment)
      .createQueryBuilder('a')
      .where('a."tenantId" = :tenantId', { tenantId })
      .andWhere('a."staffId" = :staffId', { staffId })
      .andWhere('a.start_at = :start', { start: offerA.startAt.toISOString() })
      .getMany();
    expect(atSlot).toHaveLength(1);
  }, 30_000);

  it('FR-W011 — the SAME offer accepted CONCURRENCY times at once: exactly one appointment is created, everyone else gets a clean 409', async () => {
    const customerId = await newCustomer('same-offer-replay');
    const entry = await createEntry(customerId);
    const { token, startAt } = await createOffer(entry.id, '13:00');

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => accept(token)),
    );

    const successes = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENCY - 1);
    for (const conflict of conflicts) {
      expect(conflict.body.context?.state).toBe(WaitlistOfferState.ACCEPTED);
    }

    const atSlot = await e2e.dataSource
      .getRepository(Appointment)
      .createQueryBuilder('a')
      .where('a."tenantId" = :tenantId', { tenantId })
      .andWhere('a."staffId" = :staffId', { staffId })
      .andWhere('a.start_at = :start', { start: startAt.toISOString() })
      .getMany();
    expect(atSlot).toHaveLength(1);

    const reloadedEntry = await e2e.dataSource
      .getRepository(WaitlistEntry)
      .findOne({ where: { id: entry.id } });
    expect(reloadedEntry?.state).toBe(WaitlistState.FULFILLED);
  }, 30_000);
});
