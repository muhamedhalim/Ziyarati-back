import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AnalyticsEventService } from './analytics-event.service';
import { AnalyticsEvent } from '../../entities/Analytics/AnalyticsEvent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { AnalyticsQueryBuilder } from './query/analytics-query.builder';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('AnalyticsEventService', () => {
  let service: AnalyticsEventService;
  let events: MockRepository;
  let branches: MockRepository;

  beforeEach(async () => {
    events = createMockRepository();
    branches = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsEventService,
        { provide: getRepositoryToken(AnalyticsEvent), useValue: events },
        { provide: getRepositoryToken(Branch), useValue: branches },
      ],
    }).compile();
    service = moduleRef.get(AnalyticsEventService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('track', () => {
    it('stores an event without a branch', async () => {
      events.save.mockResolvedValueOnce({ id: 'ev1' });
      await expect(service.track(TENANT, { event_type: 'login' } as any)).resolves.toEqual({ id: 'ev1' });
    });

    it('validates a supplied branch belongs to the tenant', async () => {
      branches.findOne.mockResolvedValueOnce(null);
      await expect(service.track(TENANT, { event_type: 'x', branchId: 'b1' } as any)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('list', () => {
    it('composes the query through AnalyticsQueryBuilder and returns a page', async () => {
      const qb = createMockQueryBuilder();
      events.createQueryBuilder.mockReturnValueOnce(qb);
      jest.spyOn(AnalyticsQueryBuilder, 'scoped').mockReturnValue(qb as any);
      jest.spyOn(AnalyticsQueryBuilder, 'filters').mockReturnValue(qb as any);
      jest.spyOn(AnalyticsQueryBuilder, 'page').mockResolvedValue({ data: [{ id: 'ev1' }], total: 1, page: 1, limit: 10 } as any);

      const res = await service.list(TENANT, { page: 1, limit: 10 } as any);
      expect(res.total).toBe(1);
      expect(AnalyticsQueryBuilder.scoped).toHaveBeenCalled();
    });
  });
});
