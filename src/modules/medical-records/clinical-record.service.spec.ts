import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ActivityAuditService } from '../activity-log/activity-audit.service';
import {
  ClinicalRecordService,
  type ClinicalWriteCaller,
} from './clinical-record.service';
import { ClinicalEncounter } from '../../entities/Clinical/ClinicalEncounter';
import { ClinicalEntry } from '../../entities/Clinical/ClinicalEntry';
import { ClinicalEntryRevision } from '../../entities/Clinical/ClinicalEntryRevision';
import { Customer } from '../../entities/CRM/Customer';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { ClinicalEntryKind } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const CUSTOMER = 'customer-1';
const ACTOR = 'user-1';
const OTHER_ACTOR = 'user-2';

/** A caller holding the full `clinical.records.manage` grant — unrestricted, exactly today's pre-Nurse behavior. */
const MANAGE_CALLER: ClinicalWriteCaller = {
  roles: [],
  permissions: [PERMISSION.CLINICAL_RECORDS_MANAGE],
};
/** A nursing-only caller — the new, narrower grant. */
const NURSING_CALLER: ClinicalWriteCaller = {
  roles: [],
  permissions: [PERMISSION.CLINICAL_RECORDS_NURSING],
};
/** super_admin holds neither slug explicitly — role-identity bypass instead. */
const SUPER_ADMIN_CALLER: ClinicalWriteCaller = {
  roles: [ROLE.SUPER_ADMIN],
  permissions: [],
};

/**
 * T103 (spec 014, US6) — pins FR-H008 (correction preserves history),
 * FR-H009 (stale-version 409) and FR-H013 (per-kind validation bounds).
 * Written before T107's implementation exists, per the TDD ordering the
 * task calls for.
 */
describe('ClinicalRecordService (T103 — FR-H008, FR-H009, FR-H013)', () => {
  let service: ClinicalRecordService;
  let encounters: MockRepository;
  let entries: MockRepository;
  let revisions: MockRepository;
  let customers: MockRepository;
  let appointments: MockRepository;
  let branches: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;

  const entryRepoInTx = () =>
    manager.getRepository(ClinicalEntry) as unknown as MockRepository;
  const revisionRepoInTx = () =>
    manager.getRepository(ClinicalEntryRevision) as unknown as MockRepository;

  beforeEach(async () => {
    encounters = createMockRepository();
    entries = createMockRepository();
    revisions = createMockRepository();
    customers = createMockRepository();
    appointments = createMockRepository();
    branches = createMockRepository();
    // Tenant-existence checks default to "belongs to this tenant" — the
    // 404/foreign-tenant behavior is exercised explicitly below.
    customers.exists.mockResolvedValue(true);
    appointments.exists.mockResolvedValue(true);
    branches.exists.mockResolvedValue(true);
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ClinicalRecordService,
        {
          provide: getRepositoryToken(ClinicalEncounter),
          useValue: encounters,
        },
        { provide: getRepositoryToken(ClinicalEntry), useValue: entries },
        {
          provide: getRepositoryToken(ClinicalEntryRevision),
          useValue: revisions,
        },
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: DataSource, useValue: dataSource },
        {
          provide: ActivityAuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = moduleRef.get(ClinicalRecordService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createEntry — author is server-set, never from the request body', () => {
    it('sets author from actorUserId, ignoring anything the caller might pass', async () => {
      entries.save.mockImplementationOnce(async (e: any) => e);
      const saved = await service.createEntry(TENANT, CUSTOMER, ACTOR, {
        kind: ClinicalEntryKind.NOTE,
        data: { text: 'stable' },
      }, MANAGE_CALLER);
      expect(saved.author).toEqual({ id: ACTOR });
    });
  });

  describe('per-kind validation (FR-H013) — rejected input is stored NOWHERE', () => {
    it('refuses an empty diagnosis label', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.DIAGNOSIS,
          data: { label: '', status: 'ACTIVE' },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(entries.save).not.toHaveBeenCalled();
    });

    it('refuses a diagnosis label over 300 chars', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.DIAGNOSIS,
          data: { label: 'x'.repeat(301), status: 'ACTIVE' },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(entries.save).not.toHaveBeenCalled();
    });

    it('refuses an invalid diagnosis status enum value', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.DIAGNOSIS,
          data: { label: 'Hypertension', status: 'CURED' },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('refuses a note over 5000 chars', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.NOTE,
          data: { text: 'x'.repeat(5001) },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('refuses an unrecognized (out-of-range-shaped) medication date', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.MEDICATION,
          data: { name: 'Amoxicillin', active: true, startedOn: 'not-a-date' },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it.each([
      ['systolic too low', { systolic: 39 }],
      ['systolic too high', { systolic: 301 }],
      ['diastolic too low', { diastolic: 19 }],
      ['diastolic too high', { diastolic: 201 }],
      ['heartRate too low', { heartRate: 19 }],
      ['heartRate too high', { heartRate: 301 }],
      ['temperatureC too low', { temperatureC: 24.9 }],
      ['temperatureC too high', { temperatureC: 45.1 }],
      ['weightKg too low', { weightKg: 0.1 }],
      ['weightKg too high', { weightKg: 500.1 }],
      ['heightCm too low', { heightCm: 19 }],
      ['heightCm too high', { heightCm: 261 }],
      ['spo2 too low', { spo2: 49 }],
      ['spo2 too high', { spo2: 101 }],
    ])('refuses vitals with %s', async (_label, vitals) => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.VITALS,
          data: vitals,
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(entries.save).not.toHaveBeenCalled();
    });

    it('accepts vitals exactly at each boundary', async () => {
      entries.save.mockImplementationOnce(async (e: any) => e);
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.VITALS,
          data: {
            systolic: 40,
            diastolic: 200,
            heartRate: 300,
            temperatureC: 25,
            weightKg: 500,
            heightCm: 20,
            spo2: 100,
          },
        }, MANAGE_CALLER),
      ).resolves.toBeDefined();
    });

    it('refuses an unknown field on a per-kind payload (whitelist)', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.ALLERGY,
          data: {
            substance: 'Penicillin',
            severity: 'SEVERE',
            unexpectedField: 'x',
          },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });
  });

  describe('correctEntry — FR-H008/H009', () => {
    it('preserves the prior content as a revision in the SAME transaction as the correction', async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce({
        id: 'entry-1',
        kind: ClinicalEntryKind.NOTE,
        data: { text: 'old text' },
        version: 3,
      });
      entryRepoInTx().save.mockImplementationOnce(async (e: any) => e);
      revisionRepoInTx().save.mockImplementationOnce(async (r: any) => r);

      await service.correctEntry(TENANT, 'entry-1', ACTOR, {
        version: 3,
        data: { text: 'corrected text' },
      }, MANAGE_CALLER);

      expect(revisionRepoInTx().save).toHaveBeenCalledWith(
        expect.objectContaining({ previous_data: { text: 'old text' } }),
      );
      expect(entryRepoInTx().save).toHaveBeenCalledWith(
        expect.objectContaining({ data: { text: 'corrected text' } }),
      );
    });

    it('a stale version yields 409, writes NO revision, and never touches the entry', async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce({
        id: 'entry-1',
        kind: ClinicalEntryKind.NOTE,
        data: { text: 'current text' },
        version: 5, // client thinks it's still 3
      });

      await expect(
        service.correctEntry(TENANT, 'entry-1', ACTOR, {
          version: 3,
          data: { text: 'stale edit' },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(revisionRepoInTx().save).not.toHaveBeenCalled();
      expect(entryRepoInTx().save).not.toHaveBeenCalled();
    });

    it("a foreign tenant's entry is a 404, never leaked", async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce(null);
      await expect(
        service.correctEntry(TENANT, 'someone-elses-entry', ACTOR, {
          version: 1,
          data: { text: 'x' },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('the correction itself is also validated per-kind — an invalid correction is rejected, prior content untouched', async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce({
        id: 'entry-1',
        kind: ClinicalEntryKind.VITALS,
        data: { heartRate: 80 },
        version: 1,
      });
      await expect(
        service.correctEntry(TENANT, 'entry-1', ACTOR, {
          version: 1,
          data: { heartRate: 999 },
        }, MANAGE_CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(revisionRepoInTx().save).not.toHaveBeenCalled();
    });
  });

  /**
   * Nurse role — `clinical.records.nursing` vs `.manage`. The route
   * (`ClinicalController`) admits either slug via `@RequireAnyPermission`;
   * these tests pin the SERVICE-layer split that decides what each may
   * actually do, per rbac.constants.ts's docblock on the permission.
   */
  describe('clinical.records.nursing — kind + own-author restriction', () => {
    it('a nursing-only caller may create a NOTE entry', async () => {
      entries.save.mockImplementationOnce(async (e: any) => e);
      await expect(
        service.createEntry(
          TENANT,
          CUSTOMER,
          ACTOR,
          { kind: ClinicalEntryKind.NOTE, data: { text: 'vitals stable' } },
          NURSING_CALLER,
        ),
      ).resolves.toBeDefined();
    });

    it('a nursing-only caller may create a VITALS entry', async () => {
      entries.save.mockImplementationOnce(async (e: any) => e);
      await expect(
        service.createEntry(
          TENANT,
          CUSTOMER,
          ACTOR,
          { kind: ClinicalEntryKind.VITALS, data: { heartRate: 80 } },
          NURSING_CALLER,
        ),
      ).resolves.toBeDefined();
    });

    it.each([
      ClinicalEntryKind.DIAGNOSIS,
      ClinicalEntryKind.MEDICATION,
      ClinicalEntryKind.ALLERGY,
    ])(
      'a nursing-only caller is REFUSED creating a %s entry (403), and nothing is stored',
      async (kind) => {
        await expect(
          service.createEntry(
            TENANT,
            CUSTOMER,
            ACTOR,
            { kind, data: {} },
            NURSING_CALLER,
          ),
        ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
        expect(entries.save).not.toHaveBeenCalled();
      },
    );

    it('a MANAGE caller is unrestricted by kind — DIAGNOSIS still succeeds', async () => {
      entries.save.mockImplementationOnce(async (e: any) => e);
      await expect(
        service.createEntry(
          TENANT,
          CUSTOMER,
          ACTOR,
          {
            kind: ClinicalEntryKind.DIAGNOSIS,
            data: { label: 'Hypertension', status: 'ACTIVE' },
          },
          MANAGE_CALLER,
        ),
      ).resolves.toBeDefined();
    });

    it('super_admin (role-identity bypass) is unrestricted by kind, even with no explicit permission slug', async () => {
      entries.save.mockImplementationOnce(async (e: any) => e);
      await expect(
        service.createEntry(
          TENANT,
          CUSTOMER,
          ACTOR,
          {
            kind: ClinicalEntryKind.MEDICATION,
            data: { name: 'Amoxicillin', active: true },
          },
          SUPER_ADMIN_CALLER,
        ),
      ).resolves.toBeDefined();
    });

    it('a nursing-only caller may correct their OWN NOTE entry', async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce({
        id: 'entry-1',
        kind: ClinicalEntryKind.NOTE,
        data: { text: 'old' },
        version: 1,
        author: { id: ACTOR },
      });
      entryRepoInTx().save.mockImplementationOnce(async (e: any) => e);
      revisionRepoInTx().save.mockImplementationOnce(async (r: any) => r);

      await expect(
        service.correctEntry(
          TENANT,
          'entry-1',
          ACTOR,
          { version: 1, data: { text: 'new' } },
          NURSING_CALLER,
        ),
      ).resolves.toBeDefined();
    });

    it("a nursing-only caller is REFUSED correcting ANOTHER author's NOTE entry (403), version never checked", async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce({
        id: 'entry-1',
        kind: ClinicalEntryKind.NOTE,
        data: { text: 'old' },
        version: 1,
        author: { id: OTHER_ACTOR }, // a doctor's entry
      });

      await expect(
        service.correctEntry(
          TENANT,
          'entry-1',
          ACTOR,
          // A stale version would 409 — proves the 403 is checked FIRST.
          { version: 99, data: { text: 'new' } },
          NURSING_CALLER,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
      expect(entryRepoInTx().save).not.toHaveBeenCalled();
      expect(revisionRepoInTx().save).not.toHaveBeenCalled();
    });

    it('a nursing-only caller is REFUSED correcting their OWN DIAGNOSIS-kind entry (403)', async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce({
        id: 'entry-1',
        kind: ClinicalEntryKind.DIAGNOSIS,
        data: { label: 'Hypertension', status: 'ACTIVE' },
        version: 1,
        author: { id: ACTOR },
      });

      await expect(
        service.correctEntry(
          TENANT,
          'entry-1',
          ACTOR,
          { version: 1, data: { label: 'Hypertension', status: 'RESOLVED' } },
          NURSING_CALLER,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
      expect(entryRepoInTx().save).not.toHaveBeenCalled();
    });

    it("a MANAGE caller may correct ANOTHER author's entry — unrestricted, exactly today's behavior", async () => {
      entryRepoInTx().findOne.mockResolvedValueOnce({
        id: 'entry-1',
        kind: ClinicalEntryKind.DIAGNOSIS,
        data: { label: 'Hypertension', status: 'ACTIVE' },
        version: 1,
        author: { id: OTHER_ACTOR },
      });
      entryRepoInTx().save.mockImplementationOnce(async (e: any) => e);
      revisionRepoInTx().save.mockImplementationOnce(async (r: any) => r);

      await expect(
        service.correctEntry(
          TENANT,
          'entry-1',
          ACTOR,
          { version: 1, data: { label: 'Hypertension', status: 'RESOLVED' } },
          MANAGE_CALLER,
        ),
      ).resolves.toBeDefined();
    });
  });

  /**
   * Tenant-existence hardening (Phase 1 item 7 of the Nurse plan) — a
   * fabricated or cross-tenant `customerId`/`appointmentId`/`branchId` on a
   * clinical CREATE must 404, never attach unchecked or 500 on an FK
   * violation.
   */
  describe('create-time tenant-existence checks', () => {
    it('createEntry 404s when the customer does not belong to this tenant', async () => {
      customers.exists.mockResolvedValueOnce(false);
      await expect(
        service.createEntry(
          TENANT,
          'foreign-customer',
          ACTOR,
          { kind: ClinicalEntryKind.NOTE, data: { text: 'x' } },
          MANAGE_CALLER,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(entries.save).not.toHaveBeenCalled();
    });

    it('createEncounter 404s when the appointmentId does not belong to this tenant', async () => {
      appointments.exists.mockResolvedValueOnce(false);
      await expect(
        service.createEncounter(TENANT, CUSTOMER, ACTOR, {
          appointmentId: 'foreign-appointment',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(encounters.save).not.toHaveBeenCalled();
    });

    it('createEncounter 404s when the branchId does not belong to this tenant', async () => {
      branches.exists.mockResolvedValueOnce(false);
      await expect(
        service.createEncounter(TENANT, CUSTOMER, ACTOR, {
          branchId: 'foreign-branch',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(encounters.save).not.toHaveBeenCalled();
    });

    it('createEncounter succeeds when customer/appointment/branch all belong to this tenant', async () => {
      encounters.save.mockImplementationOnce(async (e: any) => e);
      await expect(
        service.createEncounter(TENANT, CUSTOMER, ACTOR, {
          appointmentId: 'appt-1',
          branchId: 'branch-1',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('getEncounter / listRevisions / getEntry — cross-tenant 404s', () => {
    it('getEncounter returns the encounter for this tenant', async () => {
      encounters.findOne.mockResolvedValueOnce({ id: 'enc-1' });
      await expect(service.getEncounter(TENANT, 'enc-1')).resolves.toEqual({
        id: 'enc-1',
      });
    });

    it("getEncounter 404s a foreign tenant's encounter", async () => {
      encounters.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getEncounter(TENANT, 'someone-elses-encounter'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('listRevisions returns append-only history, newest first', async () => {
      entries.findOne.mockResolvedValueOnce({ id: 'entry-1' });
      revisions.find.mockResolvedValueOnce([{ id: 'rev-2' }, { id: 'rev-1' }]);
      const result = await service.listRevisions(TENANT, 'entry-1');
      expect(result).toEqual([{ id: 'rev-2' }, { id: 'rev-1' }]);
      expect(revisions.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { created_at: 'DESC' } }),
      );
    });

    it("listRevisions 404s a foreign tenant's entry", async () => {
      entries.findOne.mockResolvedValueOnce(null);
      await expect(
        service.listRevisions(TENANT, 'someone-elses-entry'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(revisions.find).not.toHaveBeenCalled();
    });

    it('listRevisions returns an empty array for an entry that has never been corrected', async () => {
      entries.findOne.mockResolvedValueOnce({ id: 'entry-1' });
      revisions.find.mockResolvedValueOnce([]);
      await expect(service.listRevisions(TENANT, 'entry-1')).resolves.toEqual(
        [],
      );
    });

    it('listRevisions propagates a database failure instead of swallowing it into an empty array', async () => {
      entries.findOne.mockResolvedValueOnce({ id: 'entry-1' });
      const dbError = Object.assign(new Error('query failed'), {
        name: 'QueryFailedError',
      });
      revisions.find.mockRejectedValueOnce(dbError);
      await expect(
        service.listRevisions(TENANT, 'entry-1'),
      ).rejects.toBe(dbError);
    });

    it("getEntry 404s a foreign tenant's entry", async () => {
      entries.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getEntry(TENANT, 'someone-elses-entry'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('softDeleteEntry — FR-H014, soft delete only', () => {
    it('calls softDelete, never a hard delete', async () => {
      entries.findOne.mockResolvedValueOnce({ id: 'entry-1' });
      await service.softDeleteEntry(TENANT, 'entry-1');
      expect(entries.softDelete).toHaveBeenCalledWith('entry-1');
      expect(entries.delete).not.toHaveBeenCalled();
    });

    it("a foreign tenant's entry is a 404, never leaked", async () => {
      entries.findOne.mockResolvedValueOnce(null);
      await expect(
        service.softDeleteEntry(TENANT, 'someone-elses-entry'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(entries.softDelete).not.toHaveBeenCalled();
    });
  });
});
