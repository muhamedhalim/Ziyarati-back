import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SubscriptionsProcessor } from './subscriptions.processor';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('SubscriptionsProcessor', () => {
  let processor: SubscriptionsProcessor;
  let subscriptions: MockRepository;

  beforeEach(async () => {
    subscriptions = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsProcessor,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
      ],
    }).compile();
    processor = moduleRef.get(SubscriptionsProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  it('counts subscriptions due for renewal grouped by tenant', async () => {
    subscriptions.find.mockResolvedValueOnce([
      { tenant: { id: 't1' } },
      { tenant: { id: 't1' } },
      { tenant: { id: 't2' } },
    ]);
    const result = await processor.process({} as any);
    expect(result).toEqual({ due: 3, tenants: 2 });
  });

  it('returns zero when nothing is due', async () => {
    subscriptions.find.mockResolvedValueOnce([]);
    expect(await processor.process({} as any)).toEqual({ due: 0, tenants: 0 });
  });

  it('pages through a full page followed by a partial page (L8)', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      tenant: { id: `t${i % 3}` },
    }));
    const lastPage = [{ tenant: { id: 't0' } }, { tenant: { id: 't3' } }];
    subscriptions.find
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce(lastPage);

    const result = await processor.process({} as any);

    expect(result).toEqual({ due: 1002, tenants: 4 });
    expect(subscriptions.find).toHaveBeenCalledTimes(2);
    expect(subscriptions.find).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        select: { id: true, tenant: { id: true } },
        order: { id: 'ASC' },
        skip: 0,
        take: 1000,
      }),
    );
    expect(subscriptions.find).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ skip: 1000, take: 1000 }),
    );
  });
});
