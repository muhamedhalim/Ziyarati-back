import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  CustomerService,
  PROVIDER_EDITABLE_CUSTOMER_FIELDS,
} from './customer.service';
import { Customer } from '../../entities/CRM/Customer';
import { ErrorCode } from '../../common/errors';
import { StaffScopeService } from '../../core/staff-scope/staff-scope.service';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { UsageService } from '../subscription-billing/usage.service';

const TENANT = 't1';

describe('CustomerService', () => {
  let service: CustomerService;
  let customers: MockRepository;
  let usage: { assertResourceWithinLimit: jest.Mock };
  let staffScope: { hasAppointmentWithCustomer: jest.Mock };

  beforeEach(async () => {
    customers = createMockRepository();
    staffScope = { hasAppointmentWithCustomer: jest.fn().mockResolvedValue(true) };
    // T044 (015-db-api-efficiency-audit, P7-2/ORM-001): list() now reads the
    // tenant FK column via entity metadata (R-11 — Customer exposes no plain
    // `tenantId` property), the same `.metadata.findRelationWithPropertyPath`
    // pattern used elsewhere in this audit. `tenantId` matches the real
    // column name (BaselineSchema migration: `customers."tenantId"`).
    (customers as unknown as { metadata: unknown }).metadata = {
      name: 'Customer',
      findRelationWithPropertyPath: (path: string) =>
        path === 'tenant' ? { joinColumns: [{ databaseName: 'tenantId' }] } : undefined,
    };
    usage = {
      assertResourceWithinLimit: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerService,
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: UsageService, useValue: usage },
        { provide: StaffScopeService, useValue: staffScope },
      ],
    }).compile();
    service = moduleRef.get(CustomerService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    // `max_customers` is a real plan cap and "add a patient" is the deliberate
    // action it should refuse. Scoped to CRM, so a tenant running on a
    // super-admin grant (no plan) passes rather than 404ing.
    it('checks the max_customers plan cap before writing', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.count.mockResolvedValueOnce(7);
      await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
      } as any);
      expect(usage.assertResourceWithinLimit).toHaveBeenCalledWith(
        TENANT,
        'customers',
        7,
      );
    });

    it('does not write when the plan cap refuses', async () => {
      usage.assertResourceWithinLimit.mockRejectedValueOnce(
        Object.assign(new Error('cap'), {
          code: ErrorCode.UNPROCESSABLE_ENTITY,
        }),
      );
      await expect(
        service.create(TENANT, { phone: '+966500', email: 'a@b.com' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(customers.save).not.toHaveBeenCalled();
    });

    it('creates a customer', async () => {
      customers.save.mockResolvedValueOnce({ id: 'c1' });
      await expect(
        service.create(TENANT, { phone: '+966500', email: 'a@b.com' } as any),
      ).resolves.toEqual({ id: 'c1' });
    });

    // Product requirement: phone is NOT a uniqueness key — multiple customers
    // may legitimately share one (e.g. a shared household line). Unlike
    // national_id below, no pre-check is even attempted for phone.
    it('does not check phone uniqueness — creates successfully with no lookup, even if another customer shares the phone', async () => {
      customers.save.mockResolvedValueOnce({ id: 'c2' });
      await expect(
        service.create(TENANT, { phone: '+966500', email: 'b@b.com' } as any),
      ).resolves.toEqual({ id: 'c2' });
      expect(customers.findOne).not.toHaveBeenCalled();
    });

    it('rejects a duplicate national_id within the tenant', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(
        service.create(TENANT, {
          phone: '+966500',
          email: 'a@b.com',
          national_id: 'ID-1',
        } as any),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    // M-09/T157 gap-closure: recipient locale must be persisted at create time
    // (the only settable-by-staff signal, since customers have no
    // authenticated UI of their own to declare a locale — see data-model.md §2.6).
    it('[M-09] persists preferred_locale when provided', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        preferred_locale: 'ar',
      } as any);
      expect(res).toEqual(expect.objectContaining({ preferred_locale: 'ar' }));
    });

    it('[M-09] leaves preferred_locale undefined (not a guessed default) when omitted', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
      } as any);
      expect(res.preferred_locale).toBeUndefined();
    });

    it('persists chronic_diseases when has_chronic_diseases is true', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        has_chronic_diseases: true,
        chronic_diseases: 'Type 2 diabetes',
      } as any);
      expect(res).toEqual(
        expect.objectContaining({
          has_chronic_diseases: true,
          chronic_diseases: 'Type 2 diabetes',
        }),
      );
    });

    it('rejects has_chronic_diseases=true without chronic_diseases (server-side, not just DTO)', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create(TENANT, {
          phone: '+966500',
          email: 'a@b.com',
          has_chronic_diseases: true,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(customers.save).not.toHaveBeenCalled();
    });

    it('forces chronic_diseases to null when has_chronic_diseases is false, even if a value was sent', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        has_chronic_diseases: false,
        chronic_diseases: 'should be ignored',
      } as any);
      expect(res.chronic_diseases).toBeNull();
    });

    it('defaults has_chronic_diseases to false and chronic_diseases to null when omitted', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
      } as any);
      expect(res.has_chronic_diseases).toBe(false);
      expect(res.chronic_diseases).toBeNull();
    });

    it('persists has_health_insurance when provided', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        has_health_insurance: true,
      } as any);
      expect(res.has_health_insurance).toBe(true);
    });

    it('leaves has_health_insurance undefined (tri-state "never asked") when omitted', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
      } as any);
      expect(res.has_health_insurance).toBeUndefined();
    });
  });

  describe('update', () => {
    it('updates phone freely (not a uniqueness key) — no extra lookup beyond findOneOrThrow', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1', phone: '+966500' }); // findOneOrThrow only
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', {
        phone: '+966511',
        full_name: 'New',
      } as any);
      expect(res).toEqual(
        expect.objectContaining({ phone: '+966511', full_name: 'New' }),
      );
      expect(customers.findOne).toHaveBeenCalledTimes(1);
    });

    it('throws when the customer does not exist', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      await expect(
        service.update(TENANT, 'x', {} as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('rejects an update to a national_id already used by another customer', async () => {
      customers.findOne
        .mockResolvedValueOnce({
          id: 'c1',
          phone: '+966500',
          national_id: null,
        })
        .mockResolvedValueOnce({ id: 'c2' }); // national_id taken by another
      await expect(
        service.update(TENANT, 'c1', { national_id: 'ID-1' } as any),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('[M-09] updates preferred_locale via the generic field loop', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        preferred_locale: undefined,
      });
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', {
        preferred_locale: 'ar',
      } as any);
      expect(res).toEqual(expect.objectContaining({ preferred_locale: 'ar' }));
    });

    it('clears chronic_diseases when editing from Yes to No, even if only the boolean is sent', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        has_chronic_diseases: true,
        chronic_diseases: 'Type 2 diabetes',
      });
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', {
        has_chronic_diseases: false,
      } as any);
      expect(res.has_chronic_diseases).toBe(false);
      expect(res.chronic_diseases).toBeNull();
    });

    it('rejects switching has_chronic_diseases to true without supplying chronic_diseases', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        has_chronic_diseases: false,
        chronic_diseases: null,
      });
      await expect(
        service.update(TENANT, 'c1', { has_chronic_diseases: true } as any),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(customers.save).not.toHaveBeenCalled();
    });

    it('keeps existing chronic_diseases text on an update that does not touch either field', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        has_chronic_diseases: true,
        chronic_diseases: 'Asthma',
      });
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', {
        full_name: 'New',
      } as any);
      expect(res.chronic_diseases).toBe('Asthma');
    });
  });

  // Doctor's `crm.customers.update_own` path — ownership + a field allow-list.
  describe('updateOwnPatient / assertOwnPatient', () => {
    const DOCTOR_USER = 'doctor-user';

    it('lets a provider edit the contact/demographic fields of a patient they have an appointment with', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1', phone: '+966500' });
      customers.save.mockImplementationOnce(async (c: any) => c);

      const res = await service.updateOwnPatient(TENANT, DOCTOR_USER, 'c1', {
        full_name: 'New Name',
        phone: '+966511',
        email: 'new@x.com',
        gender: 'FEMALE',
        date_of_birth: '1990-01-01',
        preferred_locale: 'ar',
      } as any);

      expect(res).toEqual(
        expect.objectContaining({ full_name: 'New Name', phone: '+966511' }),
      );
      expect(staffScope.hasAppointmentWithCustomer).toHaveBeenCalledWith(
        TENANT,
        DOCTOR_USER,
        'c1',
      );
    });

    it('costs exactly ONE customer lookup — the shared update body is not re-loaded', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1', phone: '+966500' });
      customers.save.mockImplementationOnce(async (c: any) => c);

      await service.updateOwnPatient(TENANT, DOCTOR_USER, 'c1', {
        full_name: 'X',
      } as any);

      expect(customers.findOne).toHaveBeenCalledTimes(1);
    });

    it('refuses a patient the provider has NO appointment with (403) and never writes', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c2' });
      staffScope.hasAppointmentWithCustomer.mockResolvedValueOnce(false);

      await expect(
        service.updateOwnPatient(TENANT, DOCTOR_USER, 'c2', {
          full_name: 'Hijack',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(customers.save).not.toHaveBeenCalled();
    });

    it('404s a customer that is not in this tenant BEFORE asking about the relationship — a foreign id is indistinguishable from a missing one', async () => {
      customers.findOne.mockResolvedValueOnce(null);

      await expect(
        service.updateOwnPatient(TENANT, DOCTOR_USER, 'foreign', {
          full_name: 'x',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(staffScope.hasAppointmentWithCustomer).not.toHaveBeenCalled();
    });

    it.each([
      'is_active',
      'marketing_opt_in',
      'source',
      'national_id',
      'whatsapp_id',
      'whatsapp_name',
      'has_health_insurance',
    ])(
      'refuses %s (needs crm.customers.manage) with 403, naming the field — never silently dropped',
      async (field) => {
        customers.findOne.mockResolvedValueOnce({ id: 'c1', phone: '+966500' });

        await expect(
          service.updateOwnPatient(TENANT, DOCTOR_USER, 'c1', {
            full_name: 'ok',
            [field]: field === 'is_active' ? false : 'x',
          } as any),
        ).rejects.toMatchObject({
          code: ErrorCode.FORBIDDEN,
          message: expect.stringContaining(field),
        });
        expect(customers.save).not.toHaveBeenCalled();
      },
    );

    it('a refused field is refused even when it is the ONLY field, and an undefined value does not trip the allow-list', async () => {
      customers.findOne.mockResolvedValue({ id: 'c1', phone: '+966500' });
      customers.save.mockImplementation(async (c: any) => c);

      await expect(
        service.updateOwnPatient(TENANT, DOCTOR_USER, 'c1', {
          national_id: 'ID-9',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

      // A DTO instance can carry own keys whose value is undefined; those must
      // not count as an attempted change.
      await expect(
        service.updateOwnPatient(TENANT, DOCTOR_USER, 'c1', {
          full_name: 'ok',
          is_active: undefined,
          national_id: undefined,
        } as any),
      ).resolves.toBeDefined();
    });

    it('the allow-list is an ALLOW-list: exactly the intake/contact fields, nothing else', () => {
      expect([...PROVIDER_EDITABLE_CUSTOMER_FIELDS].sort()).toEqual([
        'chronic_diseases',
        'date_of_birth',
        'email',
        'full_name',
        'gender',
        'has_chronic_diseases',
        'phone',
        'preferred_locale',
      ]);
    });

    it('keeps the chronic-disease cross-field rule authoritative on the provider path too', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        has_chronic_diseases: false,
        chronic_diseases: null,
      });

      await expect(
        service.updateOwnPatient(TENANT, DOCTOR_USER, 'c1', {
          has_chronic_diseases: true,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('assertOwnPatient (used by the profile write) applies the same tenant + relationship rules', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1' });
      await expect(
        service.assertOwnPatient(TENANT, DOCTOR_USER, 'c1'),
      ).resolves.toBeUndefined();

      customers.findOne.mockResolvedValueOnce({ id: 'c2' });
      staffScope.hasAppointmentWithCustomer.mockResolvedValueOnce(false);
      await expect(
        service.assertOwnPatient(TENANT, DOCTOR_USER, 'c2'),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

      customers.findOne.mockResolvedValueOnce(null);
      await expect(
        service.assertOwnPatient(TENANT, DOCTOR_USER, 'nope'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('the ordinary update() path (manage holders, the integration API) never consults the relationship', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1', phone: '+966500' });
      customers.save.mockImplementationOnce(async (c: any) => c);

      await service.update(TENANT, 'c1', { national_id: undefined, source: 'x' } as any);

      expect(staffScope.hasAppointmentWithCustomer).not.toHaveBeenCalled();
    });
  });

  describe('remove / getDetails / findOneOrThrow', () => {
    it('soft-deletes an existing customer', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1' });
      const res = await service.remove(TENANT, 'c1');
      expect(customers.softDelete).toHaveBeenCalledWith('c1');
      expect(res).toEqual({ id: 'c1', deleted: true });
    });

    it('getDetails throws NOT_FOUND for an unknown/cross-tenant id', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getDetails(TENANT, 'x', false),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    describe('getDetails — T108 (spec 014, US6, FR-H010a/d/e — BREAKING)', () => {
      const customerWithProfile = () => ({
        id: 'c1',
        full_name: 'Test Patient',
        has_chronic_diseases: true,
        chronic_diseases: 'Asthma',
        has_health_insurance: true,
        profile: {
          id: 'p1',
          medical_history: 'Appendectomy 2019',
          allergies: 'Penicillin',
          blood_type: 'O+',
          notes: 'Prefers morning appointments',
          emergency_contact_name: 'Jane Doe',
          emergency_contact_phone: '+966500000000',
        },
      });

      it('strips the 4 clinical profile fields without clinical.records.read', async () => {
        customers.findOne.mockResolvedValueOnce(customerWithProfile());
        const res = await service.getDetails(TENANT, 'c1', false);
        expect(res.profile).not.toHaveProperty('medical_history');
        expect(res.profile).not.toHaveProperty('allergies');
        expect(res.profile).not.toHaveProperty('blood_type');
        expect(res.profile).not.toHaveProperty('notes');
      });

      it('KEEPS emergency_contact_name/phone without clinical.records.read (FR-H010e — same entity, non-clinical)', async () => {
        customers.findOne.mockResolvedValueOnce(customerWithProfile());
        const res = await service.getDetails(TENANT, 'c1', false);
        expect(res.profile).toMatchObject({
          emergency_contact_name: 'Jane Doe',
          emergency_contact_phone: '+966500000000',
        });
      });

      it('KEEPS Customer-level chronic-condition/insurance fields regardless of clinical access (they are not on CustomerProfile)', async () => {
        customers.findOne.mockResolvedValueOnce(customerWithProfile());
        const res = await service.getDetails(TENANT, 'c1', false);
        expect(res.has_chronic_diseases).toBe(true);
        expect(res.chronic_diseases).toBe('Asthma');
        expect(res.has_health_insurance).toBe(true);
      });

      it('returns every profile field, unstripped, WITH clinical.records.read', async () => {
        customers.findOne.mockResolvedValueOnce(customerWithProfile());
        const res = await service.getDetails(TENANT, 'c1', true);
        expect(res.profile).toMatchObject({
          medical_history: 'Appendectomy 2019',
          allergies: 'Penicillin',
          blood_type: 'O+',
          notes: 'Prefers morning appointments',
        });
      });

      it('does not crash on a customer with no profile row at all', async () => {
        customers.findOne.mockResolvedValueOnce({ id: 'c1', profile: null });
        await expect(
          service.getDetails(TENANT, 'c1', false),
        ).resolves.toMatchObject({ id: 'c1' });
      });
    });

    it('findOneOrThrow returns the customer', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1' });
      await expect(service.findOneOrThrow(TENANT, 'c1')).resolves.toEqual({
        id: 'c1',
      });
    });
  });

  // F-19 (Phase 2): a public booking is attached to an existing record only when the
  // phone AND the name match; anything else gets a record of its own.
  describe('findOrCreateForBooking — identity is not decided by the phone alone', () => {
    const PHONE = '966500123456';
    const existing = (over: Record<string, unknown> = {}) => ({
      id: 'c-existing',
      phone: PHONE,
      full_name: 'Sara Al-Otaibi',
      ...over,
    });
    let created: Record<string, unknown>[];

    beforeEach(() => {
      created = [];
      customers.count.mockResolvedValue(0);
      customers.save.mockImplementation(async (e: any) => {
        const row = { id: `c-new-${created.length + 1}`, ...e };
        created.push(row);
        return row;
      });
    });

    it('reuses the record when phone and name both match', async () => {
      customers.find.mockResolvedValueOnce([existing()]);
      const c = await service.findOrCreateForBooking(TENANT, { fullName: 'Sara Al-Otaibi', phone: PHONE });
      expect(c.id).toBe('c-existing');
      expect(customers.save).not.toHaveBeenCalled();
    });

    it.each([
      ['case and spacing', '  sara   AL-otaibi '],
      ['a compatibility form of the same letters', 'Ｓara Al-Otaibi'],
    ])('recognises the same person despite %s', async (_label, typed) => {
      customers.find.mockResolvedValueOnce([existing()]);
      const c = await service.findOrCreateForBooking(TENANT, { fullName: typed, phone: PHONE });
      expect(c.id).toBe('c-existing');
    });

    it('ignores Arabic diacritics and tatweel when comparing names', async () => {
      customers.find.mockResolvedValueOnce([existing({ full_name: 'محمد' })]);
      const c = await service.findOrCreateForBooking(TENANT, { fullName: 'مُحَمَّـد', phone: PHONE });
      expect(c.id).toBe('c-existing');
    });

    it('creates a NEW record when the phone matches but the name does not — the existing patient is untouched', async () => {
      customers.find.mockResolvedValueOnce([existing()]);
      const c = await service.findOrCreateForBooking(TENANT, { fullName: 'Someone Else', phone: PHONE });
      expect(c.id).not.toBe('c-existing');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ full_name: 'Someone Else', phone: PHONE, source: 'public_ai' });
      expect(customers.update).not.toHaveBeenCalled();
    });

    it('never treats a missing name as a match — an unnamed record cannot be claimed by phone', async () => {
      customers.find.mockResolvedValueOnce([existing({ full_name: undefined })]);
      const noName = await service.findOrCreateForBooking(TENANT, { phone: PHONE });
      expect(noName.id).not.toBe('c-existing');
      customers.find.mockResolvedValueOnce([existing({ full_name: undefined })]);
      const blankName = await service.findOrCreateForBooking(TENANT, { fullName: '   ', phone: PHONE });
      expect(blankName.id).not.toBe('c-existing');
    });

    it('picks the record whose NAME matches when several patients share the number', async () => {
      customers.find.mockResolvedValueOnce([
        existing({ id: 'c-mother', full_name: 'Huda Salem' }),
        existing({ id: 'c-child', full_name: 'Adam Salem' }),
      ]);
      const c = await service.findOrCreateForBooking(TENANT, { fullName: 'Adam Salem', phone: PHONE });
      expect(c.id).toBe('c-child');
    });

    it('looks only inside the tenant it was given, and only at a bounded number of rows', async () => {
      customers.find.mockResolvedValueOnce([]);
      await service.findOrCreateForBooking(TENANT, { fullName: 'Nadia', phone: PHONE });
      expect(customers.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenant: { id: TENANT }, phone: PHONE }, take: 20 }),
      );
    });

    it('gives each record its own synthetic email — one phone may now own several', async () => {
      customers.find.mockResolvedValue([]);
      await service.findOrCreateForBooking(TENANT, { fullName: 'One', phone: PHONE });
      await service.findOrCreateForBooking(TENANT, { fullName: 'Two', phone: PHONE });
      const emails = created.map((c) => c.email as string);
      expect(new Set(emails).size).toBe(2);
      for (const e of emails) expect(e).toMatch(/^patient\+t1-966500123456-[0-9a-f]{8}@booking\.internal$/);
    });

    it('uses the address the visitor typed; if it belongs to another record it is not attached — a private one is minted instead', async () => {
      customers.find.mockResolvedValue([]);
      customers.save.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
      const c = await service.findOrCreateForBooking(TENANT, {
        fullName: 'Layla',
        phone: PHONE,
        email: 'taken@example.com',
      });
      expect(c.id).toBeTruthy();
      expect(created).toHaveLength(1);
      expect(created[0].email).toMatch(/@booking\.internal$/);
    });

    it('a concurrent insert of the SAME person is re-read rather than duplicated', async () => {
      customers.find.mockResolvedValueOnce([]); // first look: nobody
      customers.save.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
      customers.find.mockResolvedValueOnce([existing({ id: 'c-raced', full_name: 'Omar' })]); // the racer's row
      const c = await service.findOrCreateForBooking(TENANT, { fullName: 'Omar', phone: PHONE });
      expect(c.id).toBe('c-raced');
      expect(created).toHaveLength(0);
    });

    it('rethrows a failure that is not an address clash (no address was supplied)', async () => {
      customers.find.mockResolvedValue([]);
      customers.save.mockRejectedValueOnce(new Error('connection lost'));
      await expect(service.findOrCreateForBooking(TENANT, { fullName: 'Omar', phone: PHONE })).rejects.toThrow('connection lost');
    });
  });

  describe('setInsuranceStatus', () => {
    it('writes has_health_insurance via a tenant-scoped targeted update', async () => {
      await service.setInsuranceStatus(TENANT, 'c1', true);
      expect(customers.update).toHaveBeenCalledWith(
        { id: 'c1', tenant: { id: TENANT } },
        { has_health_insurance: true },
      );
    });
  });

  describe('list / search', () => {
    /** Wires `customers.createQueryBuilder()` to return `getManyAndCount()`
     *  resolving to `[rows, total]` for exactly the next call. */
    function mockList(rows: unknown[], total: number) {
      const qb = createMockQueryBuilder();
      (qb as unknown as { getManyAndCount: jest.Mock }).getManyAndCount = jest
        .fn()
        .mockResolvedValue([rows, total]);
      customers.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    }

    it('lists customers with an active filter and pagination', async () => {
      mockList([{ id: 'c1' }], 1);
      const res = await service.list(TENANT, {
        page: 1,
        limit: 10,
        isActive: true,
      } as any);
      expect(res).toEqual({
        data: [{ id: 'c1' }],
        total: 1,
        page: 1,
        limit: 10,
      });
    });

    // T044 — the mandatory per-site assertion set (identical result,
    // empty for non-match, empty for a foreign tenant, soft-delete
    // exclusion left to TypeORM rather than hand-written, statement count).
    it('returns an empty page when no customers match', async () => {
      mockList([], 0);
      const res = await service.list(TENANT, { page: 1, limit: 10 } as any);
      expect(res).toEqual({ data: [], total: 0, page: 1, limit: 10 });
    });

    it('scopes strictly by the FK column resolved from metadata — a foreign tenant id never widens the filter', async () => {
      const qb = mockList([], 0);
      await service.list('other-tenant', { page: 1, limit: 10 } as any);
      expect(qb.where).toHaveBeenCalledWith('c."tenantId" = :tenantId', {
        tenantId: 'other-tenant',
      });
    });

    it('never hand-writes a deleted_at predicate — soft-delete exclusion is TypeORM auto-injection, not a copy that could drift', async () => {
      const qb = mockList([{ id: 'c1' }], 1);
      await service.list(TENANT, { page: 1, limit: 10, isActive: true } as any);
      const allCalls = [...qb.where.mock.calls, ...qb.andWhere.mock.calls];
      expect(allCalls.some(([sql]) => /deleted_at/i.test(String(sql)))).toBe(false);
    });

    it('issues exactly one query (createQueryBuilder, not findAndCount) with limit/offset, never skip/take', async () => {
      const qb = mockList([{ id: 'c1' }], 1);
      await service.list(TENANT, { page: 2, limit: 10, isActive: true } as any);

      expect(customers.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(customers.findAndCount).not.toHaveBeenCalled();
      expect(qb.getManyAndCount).toHaveBeenCalledTimes(1);
      expect(qb.limit).toHaveBeenCalledWith(10);
      expect(qb.offset).toHaveBeenCalledWith(10); // (page 2 - 1) * limit 10
      expect(qb.skip).not.toHaveBeenCalled();
      expect(qb.take).not.toHaveBeenCalled();
    });

    it('search builds an OR (name/email/phone/national_id) when a query term is present', async () => {
      customers.findAndCount.mockResolvedValueOnce([[{ id: 'c1' }], 1]);
      await service.search(TENANT, {
        page: 1,
        limit: 10,
        q: 'ali',
        tagIds: ['tag1'],
      } as any);
      const arg = customers.findAndCount.mock.calls[0][0];
      expect(Array.isArray(arg.where)).toBe(true);
      expect(arg.where).toHaveLength(4);
    });

    it('search matches national_id with the same partial ILIKE term as name/email/phone', async () => {
      customers.findAndCount.mockResolvedValueOnce([[{ id: 'c1' }], 1]);
      await service.search(TENANT, { page: 1, limit: 10, q: '29801' } as any);
      const where = customers.findAndCount.mock.calls[0][0].where as any[];

      const fieldOf = (w: any) =>
        ['full_name', 'email', 'phone', 'national_id'].find((f) => f in w);
      expect(where.map(fieldOf)).toEqual([
        'full_name',
        'email',
        'phone',
        'national_id',
      ]);
      // Every branch carries the identical parameterized term — no per-field
      // divergence, and the raw term is never interpolated into anything.
      const terms = where.map((w) => w[fieldOf(w)!]);
      expect(new Set(terms.map((t) => JSON.stringify(t))).size).toBe(1);
      expect(terms[3].type).toBe('ilike');
      expect(terms[3].value).toBe('%29801%');
    });

    it('search applies tenant, active and tag filters to the national_id branch exactly as to the others', async () => {
      customers.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.search(TENANT, {
        page: 2,
        limit: 10,
        q: '29801',
        isActive: true,
        tagIds: ['tag1'],
      } as any);
      const arg = customers.findAndCount.mock.calls[0][0];
      for (const branch of arg.where as any[]) {
        expect(branch.tenant).toEqual({ id: TENANT });
        expect(branch.is_active).toBe(true);
        expect(branch.tags).toBeDefined();
      }
      // Pagination + ordering are untouched by the extra OR branch.
      expect(arg.skip).toBe(10);
      expect(arg.take).toBe(10);
      // `id` is the unique tiebreaker: rows tying on created_at must not repeat/skip across pages.
      expect(arg.order).toEqual({ created_at: 'DESC', id: 'DESC' });
    });

    it('search uses a single where object when no term is given', async () => {
      customers.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.search(TENANT, { page: 1, limit: 10 } as any);
      const arg = customers.findAndCount.mock.calls[0][0];
      expect(Array.isArray(arg.where)).toBe(false);
    });
  });
});
