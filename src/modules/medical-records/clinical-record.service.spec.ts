import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { ClinicalRecordService } from './clinical-record.service';
import { ClinicalEncounter } from '../../entities/Clinical/ClinicalEncounter';
import { ClinicalEntry } from '../../entities/Clinical/ClinicalEntry';
import { ClinicalEntryRevision } from '../../entities/Clinical/ClinicalEntryRevision';
import { ClinicalEntryKind } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
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
      });
      expect(saved.author).toEqual({ id: ACTOR });
    });
  });

  describe('per-kind validation (FR-H013) — rejected input is stored NOWHERE', () => {
    it('refuses an empty diagnosis label', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.DIAGNOSIS,
          data: { label: '', status: 'ACTIVE' },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(entries.save).not.toHaveBeenCalled();
    });

    it('refuses a diagnosis label over 300 chars', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.DIAGNOSIS,
          data: { label: 'x'.repeat(301), status: 'ACTIVE' },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(entries.save).not.toHaveBeenCalled();
    });

    it('refuses an invalid diagnosis status enum value', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.DIAGNOSIS,
          data: { label: 'Hypertension', status: 'CURED' },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('refuses a note over 5000 chars', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.NOTE,
          data: { text: 'x'.repeat(5001) },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('refuses an unrecognized (out-of-range-shaped) medication date', async () => {
      await expect(
        service.createEntry(TENANT, CUSTOMER, ACTOR, {
          kind: ClinicalEntryKind.MEDICATION,
          data: { name: 'Amoxicillin', active: true, startedOn: 'not-a-date' },
        }),
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
        }),
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
        }),
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
        }),
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
      });

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
        }),
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
        }),
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
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(revisionRepoInTx().save).not.toHaveBeenCalled();
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
