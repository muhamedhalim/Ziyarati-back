import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CustomerSegmentService } from './customer-segment.service';
import { SegmentQueryBuilder } from './segment-query.builder';
import { CustomerSegment } from '../../entities/CRM/CustomerSegment';
import { SegmentField, SegmentOperator } from './segment.constants';
import { AppError } from '../../common/errors';
import {
  createMockRepository,
  createMockDataSource,
  MockRepository,
  MockDataSource,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';

describe('CustomerSegmentService (T122 — FR-S001-S012)', () => {
  let service: CustomerSegmentService;
  let segments: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    segments = createMockRepository();
    dataSource = createMockDataSource();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerSegmentService,
        SegmentQueryBuilder,
        { provide: getRepositoryToken(CustomerSegment), useValue: segments },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(CustomerSegmentService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create/update — validated against the closed vocabulary before persisting', () => {
    it('rejects an unknown field before the segment is ever saved', async () => {
      await expect(
        service.create(TENANT, 'user-1', {
          name: 'Bad',
          match: 'ALL',
          rules: [
            {
              field: 'NOT_A_FIELD' as SegmentField,
              op: SegmentOperator.EQUALS,
            },
          ],
        }),
      ).rejects.toThrow(AppError);
      expect(segments.save).not.toHaveBeenCalled();
    });

    it('saves a valid segment stamped with the tenant and creator', async () => {
      segments.create.mockImplementation((v: unknown) => v);
      segments.save.mockImplementation((v: unknown) => Promise.resolve(v));
      const saved = await service.create(TENANT, 'user-1', {
        name: 'Active patients',
        match: 'ALL',
        rules: [
          { field: SegmentField.CUSTOMER_ACTIVE, op: SegmentOperator.IS_TRUE },
        ],
      });
      expect(segments.save).toHaveBeenCalled();
      expect((saved as { tenant: { id: string } }).tenant).toEqual({
        id: TENANT,
      });
    });
  });

  describe('preview — side-effect-free', () => {
    it('returns count, sample, consentEligibleCount and a point-in-time evaluatedAt', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([{ c: 42 }]) // count
        .mockResolvedValueOnce([{ c: 10 }]) // consentEligibleCount
        .mockResolvedValueOnce([
          { id: 'c1', fullName: 'A', lastAppointmentAt: null },
        ]); // sample

      const result = await service.preview(
        TENANT,
        [{ field: SegmentField.CUSTOMER_ACTIVE, op: SegmentOperator.IS_TRUE }],
        'ALL',
      );

      expect(result.count).toBe(42);
      expect(result.consentEligibleCount).toBe(10);
      expect(result.sample).toHaveLength(1);
      expect(new Date(result.evaluatedAt).toString()).not.toBe('Invalid Date');
      expect(segments.save).not.toHaveBeenCalled();
    });

    it('never persists or dispatches anything — 3 read-only queries, no repository writes', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([{ c: 0 }])
        .mockResolvedValueOnce([{ c: 0 }])
        .mockResolvedValueOnce([]);
      await service.preview(TENANT, [], 'ALL');
      expect(dataSource.query).toHaveBeenCalledTimes(3);
      expect(segments.save).not.toHaveBeenCalled();
      expect(segments.create).not.toHaveBeenCalled();
    });
  });

  describe('resolve — keyset pagination', () => {
    it('passes the cursor as the trailing bound parameter and returns nextCursor only on a full page', async () => {
      segments.findOne.mockResolvedValueOnce({
        id: 'seg-1',
        rules: [
          { field: SegmentField.CUSTOMER_ACTIVE, op: SegmentOperator.IS_TRUE },
        ],
        match: 'ALL',
      });
      (dataSource.query as jest.Mock).mockResolvedValueOnce([
        { id: 'c1' },
        { id: 'c2' },
      ]);

      const page = await service.resolve(TENANT, 'seg-1', 'c0', 2);

      expect(page.customerIds).toEqual(['c1', 'c2']);
      expect(page.nextCursor).toBe('c2');
      const [, params] = (dataSource.query as jest.Mock).mock.calls[0];
      expect(params[params.length - 1]).toBe('c0');
    });

    it('returns nextCursor=null when the page is short (exhausted)', async () => {
      segments.findOne.mockResolvedValueOnce({
        id: 'seg-1',
        rules: [],
        match: 'ALL',
      });
      (dataSource.query as jest.Mock).mockResolvedValueOnce([{ id: 'c1' }]);

      const page = await service.resolve(TENANT, 'seg-1', null, 500);
      expect(page.nextCursor).toBeNull();
    });

    it('throws 404 for a segment id belonging to another tenant (cross-tenant non-matching)', async () => {
      segments.findOne.mockResolvedValueOnce(null);
      await expect(
        service.resolve(TENANT, 'foreign-seg', null),
      ).rejects.toThrow(AppError);
    });
  });

  it("findOne 404s for another tenant's segment", async () => {
    segments.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'foreign')).rejects.toThrow(AppError);
  });

  it(
    "editing a segment can never alter a completed campaign run's recipients — " +
      'this service has no reference to campaign_recipients at all (T122, FR-S011)',
    () => {
      const source = fs.readFileSync(
        path.join(__dirname, 'customer-segment.service.ts'),
        'utf8',
      );
      expect(source).not.toContain('campaign_recipients');
      expect(source).not.toContain('CampaignRecipient');
    },
  );
});
