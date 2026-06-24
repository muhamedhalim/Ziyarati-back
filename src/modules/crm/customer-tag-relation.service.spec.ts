import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerTagRelationService } from './customer-tag-relation.service';
import { CustomerService } from './customer.service';
import { CustomerTagService } from './customer-tag.service';
import { CustomerTagRelation } from '../../entities/CRM/CustomerTagRelation';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('CustomerTagRelationService', () => {
  let service: CustomerTagRelationService;
  let relations: MockRepository;
  let customers: { findOneOrThrow: jest.Mock };
  let tags: { findOneOrThrow: jest.Mock };

  beforeEach(async () => {
    relations = createMockRepository();
    customers = { findOneOrThrow: jest.fn().mockResolvedValue({ id: 'c1' }) };
    tags = { findOneOrThrow: jest.fn().mockResolvedValue({ id: 'tag1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerTagRelationService,
        { provide: getRepositoryToken(CustomerTagRelation), useValue: relations },
        { provide: CustomerService, useValue: customers },
        { provide: CustomerTagService, useValue: tags },
      ],
    }).compile();
    service = moduleRef.get(CustomerTagRelationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('assigns a tag after verifying both customer and tag are tenant-owned', async () => {
    relations.findOne.mockResolvedValueOnce(null);
    relations.save.mockResolvedValueOnce({ id: 'rel-1' });
    await service.assign(TENANT, 'c1', 'tag1');
    expect(customers.findOneOrThrow).toHaveBeenCalledWith(TENANT, 'c1');
    expect(tags.findOneOrThrow).toHaveBeenCalledWith(TENANT, 'tag1');
  });

  it('is idempotent — returns the existing relation without re-saving', async () => {
    relations.findOne.mockResolvedValueOnce({ id: 'rel-1' });
    const res = await service.assign(TENANT, 'c1', 'tag1');
    expect(res).toEqual({ id: 'rel-1' });
    expect(relations.save).not.toHaveBeenCalled();
  });

  it('removes an assignment', async () => {
    relations.findOne.mockResolvedValueOnce({ id: 'rel-1' });
    const res = await service.remove(TENANT, 'c1', 'tag1');
    expect(relations.remove).toHaveBeenCalled();
    expect(res).toEqual({ customerId: 'c1', tagId: 'tag1', removed: true });
  });

  it('throws when removing an unassigned tag', async () => {
    relations.findOne.mockResolvedValueOnce(null);
    await expect(service.remove(TENANT, 'c1', 'tag1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('lists tags assigned to a customer', async () => {
    relations.find.mockResolvedValueOnce([{ id: 'rel-1', tag: { id: 'tag1' } }]);
    await expect(service.listForCustomer(TENANT, 'c1')).resolves.toHaveLength(1);
  });
});
