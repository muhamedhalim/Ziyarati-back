import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SubscriptionsProcessor } from './subscriptions.processor';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

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
});
