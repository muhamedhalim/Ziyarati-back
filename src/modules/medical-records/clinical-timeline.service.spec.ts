import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ClinicalTimelineService } from './clinical-timeline.service';
import { ClinicalEntry } from '../../entities/Clinical/ClinicalEntry';
import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { ClinicalEntryKind } from '../../entities/enums';
import {
  createMockRepository,
  createMockDataSource,
  MockRepository,
  MockDataSource,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const CUSTOMER = 'customer-1';

describe('ClinicalTimelineService (T111/T113 — FR-H005, FR-H006, FR-H007)', () => {
  let service: ClinicalTimelineService;
  let entries: MockRepository;
  let profiles: MockRepository;
  let dataSource: MockDataSource;
  let authorRepo: { find: jest.Mock };

  beforeEach(async () => {
    entries = createMockRepository();
    profiles = createMockRepository();
    dataSource = createMockDataSource();
    authorRepo = { find: jest.fn().mockResolvedValue([]) };
    dataSource.getRepository = jest.fn().mockReturnValue(authorRepo);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ClinicalTimelineService,
        { provide: getRepositoryToken(ClinicalEntry), useValue: entries },
        { provide: getRepositoryToken(CustomerProfile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(ClinicalTimelineService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getTimeline', () => {
    it('is exactly 4 queries regardless of how many rows are returned (no N+1)', async () => {
      const manyRows = Array.from({ length: 50 }, (_, i) => ({
        type: 'ENTRY',
        id: `e${i}`,
        kind: 'NOTE',
        occurred_at: new Date(),
        recorded_at: new Date(),
        author_id: 'user-1',
        data: {},
        from_cancelled_visit: false,
      }));
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce(manyRows)
        .mockResolvedValueOnce([{ c: 50 }]);
      authorRepo.find.mockResolvedValueOnce([
        { id: 'user-1', full_name: 'Dr. Ada' },
      ]);
      entries.find.mockResolvedValueOnce([]);

      await service.getTimeline(TENANT, CUSTOMER, 1, 50);

      expect(dataSource.query).toHaveBeenCalledTimes(2);
      expect(authorRepo.find).toHaveBeenCalledTimes(1);
      expect(entries.find).toHaveBeenCalledTimes(1);
    });

    it('includes active allergies on the SAME response (FR-H007 — present on every clinical read)', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ c: 0 }]);
      entries.find.mockResolvedValueOnce([
        { data: { substance: 'Penicillin', severity: 'SEVERE' } },
      ]);

      const page = await service.getTimeline(TENANT, CUSTOMER, 1, 20);

      expect(page.allergies).toEqual([
        { substance: 'Penicillin', severity: 'SEVERE' },
      ]);
    });

    it('marks an entry as fromCancelledVisit without excluding it (FR-H005)', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([
          {
            type: 'ENTRY',
            id: 'e1',
            kind: 'NOTE',
            occurred_at: new Date('2026-01-01'),
            recorded_at: new Date('2026-01-01'),
            author_id: 'user-1',
            data: { text: 'note from a cancelled visit' },
            from_cancelled_visit: true,
          },
        ])
        .mockResolvedValueOnce([{ c: 1 }]);

      const page = await service.getTimeline(TENANT, CUSTOMER, 1, 20);

      expect(page.data).toHaveLength(1);
      expect(page.data[0].fromCancelledVisit).toBe(true);
    });

    it('resolves author names in one batched lookup, never per-row', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([
          {
            type: 'ENCOUNTER',
            id: 'enc1',
            kind: null,
            occurred_at: new Date(),
            recorded_at: new Date(),
            author_id: 'user-1',
            data: {},
            from_cancelled_visit: false,
          },
          {
            type: 'ENTRY',
            id: 'e1',
            kind: 'DIAGNOSIS',
            occurred_at: new Date(),
            recorded_at: new Date(),
            author_id: 'user-1',
            data: {},
            from_cancelled_visit: false,
          },
        ])
        .mockResolvedValueOnce([{ c: 2 }]);
      authorRepo.find.mockResolvedValueOnce([
        { id: 'user-1', full_name: 'Dr. Ada' },
      ]);

      const page = await service.getTimeline(TENANT, CUSTOMER, 1, 20);

      expect(authorRepo.find).toHaveBeenCalledTimes(1);
      expect(page.data[0].author).toEqual({ id: 'user-1', name: 'Dr. Ada' });
      expect(page.data[1].author).toEqual({ id: 'user-1', name: 'Dr. Ada' });
    });

    it('passes the tenant/customer scope and pagination params to the query', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ c: 0 }]);

      await service.getTimeline(TENANT, CUSTOMER, 2, 10);

      expect(dataSource.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('ORDER BY recorded_at DESC'),
        [TENANT, CUSTOMER, 10, 10], // page 2, limit 10 -> offset 10
      );
    });
  });

  describe('getActiveAllergies (FR-H007)', () => {
    it('returns only ALLERGY-kind entries for this patient, newest first', async () => {
      entries.find.mockResolvedValueOnce([
        { data: { substance: 'Penicillin', severity: 'SEVERE' } },
      ]);
      const allergies = await service.getActiveAllergies(TENANT, CUSTOMER);
      expect(entries.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ kind: ClinicalEntryKind.ALLERGY }),
        }),
      );
      expect(allergies).toEqual([
        { substance: 'Penicillin', severity: 'SEVERE' },
      ]);
    });
  });

  describe('getSummary — allergies + legacy free-text profile (FR-H004, FR-H007)', () => {
    it('surfaces the legacy profile content, preserved not migrated', async () => {
      entries.find.mockResolvedValueOnce([]);
      profiles.findOne.mockResolvedValueOnce({
        medical_history: 'Appendectomy 2019',
        notes: 'Prefers morning visits',
      });

      const summary = await service.getSummary(TENANT, CUSTOMER);
      expect(summary.legacyProfile).toEqual({
        medical_history: 'Appendectomy 2019',
        notes: 'Prefers morning visits',
      });
    });

    it('legacyProfile is null when no profile row exists yet', async () => {
      entries.find.mockResolvedValueOnce([]);
      profiles.findOne.mockResolvedValueOnce(null);
      const summary = await service.getSummary(TENANT, CUSTOMER);
      expect(summary.legacyProfile).toBeNull();
    });
  });
});
