import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerTagService } from './customer-tag.service';
import { CustomerTag } from '../../entities/CRM/CustomerTag';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('CustomerTagService', () => {
  let service: CustomerTagService;
  let tags: MockRepository;

  beforeEach(async () => {
    tags = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [CustomerTagService, { provide: getRepositoryToken(CustomerTag), useValue: tags }],
    }).compile();
    service = moduleRef.get(CustomerTagService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a tag after a per-tenant name-uniqueness check', async () => {
    tags.findOne.mockResolvedValueOnce(null);
    tags.save.mockResolvedValueOnce({ id: 'tag-1' });
    await expect(service.create(TENANT, { name: 'VIP', color: '#f00' } as any)).resolves.toEqual({ id: 'tag-1' });
  });

  it('rejects a duplicate tag name', async () => {
    tags.findOne.mockResolvedValueOnce({ id: 'existing' });
    await expect(service.create(TENANT, { name: 'VIP' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('updates a tag and re-checks name uniqueness on rename', async () => {
    tags.findOne
      .mockResolvedValueOnce({ id: 'tag-1', name: 'VIP' }) // findOneOrThrow
      .mockResolvedValueOnce(null); // name unique
    tags.save.mockImplementationOnce(async (t: any) => t);
    const res = await service.update(TENANT, 'tag-1', { name: 'Gold' } as any);
    expect(res).toEqual(expect.objectContaining({ name: 'Gold' }));
  });

  it('removes a tag (relations cascade in the DB)', async () => {
    tags.findOne.mockResolvedValueOnce({ id: 'tag-1' });
    const res = await service.remove(TENANT, 'tag-1');
    expect(tags.remove).toHaveBeenCalled();
    expect(res).toEqual({ id: 'tag-1', deleted: true });
  });

  it('findOneOrThrow throws for an unknown tag', async () => {
    tags.findOne.mockResolvedValueOnce(null);
    await expect(service.findOneOrThrow(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('lists tags with an optional name filter', async () => {
    tags.findAndCount.mockResolvedValueOnce([[{ id: 'tag-1' }], 1]);
    const res = await service.list(TENANT, { page: 1, limit: 10, q: 'vi' } as any);
    expect(res.total).toBe(1);
  });
});
