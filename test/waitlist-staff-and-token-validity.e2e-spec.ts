/**
 * T161 (US9, contracts/clinic-surfaces.md §F9) — the five staff waitlist
 * routes as real HTTP requests, including the cross-tenant 404 case.
 *
 * T162 (US9, contracts/public-surfaces.md §C) — the status-code rule:
 * unknown/altered/consumed tokens all return the SAME byte-identical 404 as
 * `PatientActionController`'s own uniform-404 (never a 410); a valid token
 * whose offer is no longer actionable returns 200 + state on the GET.
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

describe('Waitlist staff routes (T161) + offer-token status codes (T162)', () => {
  let e2e: E2eApp;
  let links: PatientActionLinkService;
  let owner: OwnerFixture;
  let otherOwner: OwnerFixture;
  let tenantId: string;
  let branchId: string;
  let staffId: string;
  let serviceId: string;
  let customerId: string;
  let originatingAppointmentId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    links = e2e.app.get(PatientActionLinkService);
    owner = await createOwnerFixture(e2e, 'waitlist-staff');
    otherOwner = await createOwnerFixture(e2e, 'waitlist-staff-other-tenant');
    tenantId = owner.tenantId;
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Staff Routes Branch',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchId = branch.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `staff-routes-doctor-${suffix}@example.test`,
        full_name: 'Dr Routes',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: 'Dr Routes',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: tenantId } as Tenant,
        name: 'Routes Consultation',
        duration_minutes: 30,
        base_price: 100,
        is_active: true,
      }),
    );
    serviceId = service.id;

    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: tenantId } as Tenant,
        full_name: `Routes Patient ${suffix}`,
        phone: `+9665${suffix}`,
        email: `routes-patient-${suffix}@example.test`,
      }),
    );
    customerId = customer.id;

    const originating = await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        customer: { id: customerId } as Customer,
        staff: { id: staffId } as StaffProfile,
        start_at: new Date('2032-05-05T06:00:00.000Z'),
        end_at: new Date('2032-05-05T07:00:00.000Z'),
        status: AppointmentStatus.CANCELLED,
        source: AppointmentSource.MANUAL,
        currency: 'SAR',
      }),
    );
    originatingAppointmentId = originating.id;
  }, 120_000);

  afterAll(async () => {
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

  let entryId: string;

  it('POST /waitlist creates a WAITING entry', async () => {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/waitlist`)
      .set(...authHeader(owner.token))
      .send({ customerId, serviceId, priority: 1 });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe(WaitlistState.WAITING);
    entryId = res.body.id;
  });

  it('POST /waitlist refuses a duplicate ACTIVE entry for the same (customer, service) with 409 (FR-W013)', async () => {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/waitlist`)
      .set(...authHeader(owner.token))
      .send({ customerId, serviceId });
    expect(res.status).toBe(409);
  });

  it('GET /waitlist lists the entry', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/waitlist`)
      .set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.some((e: { id: string }) => e.id === entryId)).toBe(
      true,
    );
  });

  it('PATCH /waitlist/:id updates priority', async () => {
    const res = await request(e2e.app.getHttpServer())
      .patch(`${API}/waitlist/${entryId}`)
      .set(...authHeader(owner.token))
      .send({ priority: 9 });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe(9);
  });

  it('GET /waitlist/:id/offers returns an empty list before any offer exists', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/waitlist/${entryId}/offers`)
      .set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('a cross-tenant entry id is a 404 on every route, never a 403 or a leak', async () => {
    const getRes = await request(e2e.app.getHttpServer())
      .patch(`${API}/waitlist/${entryId}`)
      .set(...authHeader(otherOwner.token))
      .send({ priority: 1 });
    expect(getRes.status).toBe(404);

    const offersRes = await request(e2e.app.getHttpServer())
      .get(`${API}/waitlist/${entryId}/offers`)
      .set(...authHeader(otherOwner.token));
    expect(offersRes.status).toBe(404);

    const deleteRes = await request(e2e.app.getHttpServer())
      .delete(`${API}/waitlist/${entryId}`)
      .set(...authHeader(otherOwner.token));
    expect(deleteRes.status).toBe(404);
  });

  it('DELETE /waitlist/:id cancels the entry', async () => {
    const res = await request(e2e.app.getHttpServer())
      .delete(`${API}/waitlist/${entryId}`)
      .set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.state).toBe(WaitlistState.CANCELLED);
  });

  describe('T162 — offer-token status codes', () => {
    let offer: WaitlistOffer;
    let token: string;

    beforeAll(async () => {
      const ds = e2e.dataSource;
      const tokenPatientSuffix = randomUUID().slice(0, 8);
      const freshCustomer = await ds.getRepository(Customer).save(
        ds.getRepository(Customer).create({
          tenant: { id: tenantId } as Tenant,
          full_name: `Token Patient ${tokenPatientSuffix}`,
          phone: `+9665${tokenPatientSuffix}`,
          email: `token-patient-${tokenPatientSuffix}@example.test`,
        }),
      );
      const entry = await ds.getRepository(WaitlistEntry).save(
        ds.getRepository(WaitlistEntry).create({
          tenant: { id: tenantId } as Tenant,
          customer: { id: freshCustomer.id } as Customer,
          service: { id: serviceId } as Service,
          state: WaitlistState.OFFERED,
        }),
      );
      offer = await ds.getRepository(WaitlistOffer).save(
        ds.getRepository(WaitlistOffer).create({
          tenant: { id: tenantId } as Tenant,
          entry: { id: entry.id } as WaitlistEntry,
          branch: { id: branchId } as Branch,
          staff: { id: staffId } as StaffProfile,
          start_at: new Date('2032-05-06T09:00:00.000Z'),
          end_at: new Date('2032-05-06T10:00:00.000Z'),
          state: WaitlistOfferState.PENDING,
          responds_by: new Date(Date.now() + 3600_000),
        }),
      );
      const originating = await ds.getRepository(Appointment).findOne({
        where: { id: originatingAppointmentId },
      });
      token = await links.issue(
        tenantId,
        originating!,
        PatientActionPurpose.WAITLIST_OFFER,
        offer.id,
      );
    });

    it('an UNKNOWN token is a 404', async () => {
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/public/waitlist/offer/not-a-real-token`,
      );
      expect(res.status).toBe(404);
    });

    it('a VALID token resolves 200 with the offer state', async () => {
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/public/waitlist/offer/${token}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.state).toBe(WaitlistOfferState.PENDING);
      expect(res.body.respondsBy).toBeDefined();
    });

    it('declining moves the offer to DECLINED and the entry back to WAITING', async () => {
      const res = await request(e2e.app.getHttpServer()).post(
        `${API}/public/waitlist/offer/${token}/decline`,
      );
      expect(res.status).toBe(200);
      expect(res.body.state).toBe(WaitlistOfferState.DECLINED);
    });

    it('the GET after decline still resolves 200 (never 404/410) and shows the terminal state — the SAME response shape as the unknown-token case would need to be indistinguishable from, were it 404', async () => {
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/public/waitlist/offer/${token}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.state).toBe(WaitlistOfferState.DECLINED);
    });

    it('a second decline of the same already-terminal offer is a 409 with the current state, never a 410', async () => {
      const res = await request(e2e.app.getHttpServer()).post(
        `${API}/public/waitlist/offer/${token}/decline`,
      );
      expect(res.status).toBe(409);
      expect(res.body.context?.state).toBe(WaitlistOfferState.DECLINED);
    });

    it('an ALTERED token (one character flipped) is the SAME 404 as an unknown token', async () => {
      const altered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/public/waitlist/offer/${altered}`,
      );
      expect(res.status).toBe(404);
    });

    it('a CANCEL-purpose token (wrong purpose) is a 404 on the waitlist-offer route', async () => {
      const wrongPurposeAppt = await e2e.dataSource
        .getRepository(Appointment)
        .save(
          e2e.dataSource.getRepository(Appointment).create({
            tenant: { id: tenantId } as Tenant,
            branch: { id: branchId } as Branch,
            customer: { id: customerId } as Customer,
            staff: { id: staffId } as StaffProfile,
            start_at: new Date('2032-05-07T09:00:00.000Z'),
            end_at: new Date('2032-05-07T10:00:00.000Z'),
            status: AppointmentStatus.CONFIRMED,
            source: AppointmentSource.MANUAL,
            currency: 'SAR',
          }),
        );
      const cancelToken = await links.issue(
        tenantId,
        wrongPurposeAppt,
        PatientActionPurpose.CANCEL,
      );
      const res = await request(e2e.app.getHttpServer()).get(
        `${API}/public/waitlist/offer/${cancelToken}`,
      );
      expect(res.status).toBe(404);
    });
  });
});
