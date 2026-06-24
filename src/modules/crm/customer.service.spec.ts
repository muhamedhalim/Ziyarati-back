import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerService } from './customer.service';
import { Customer } from '../../entities/CRM/Customer';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('CustomerService', () => {
  let service: CustomerService;
  let customers: MockRepository;

  beforeEach(async () => {
    customers = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [CustomerService, { provide: getRepositoryToken(Customer), useValue: customers }],
    }).compile();
    service = moduleRef.get(CustomerService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates a customer after a tenant-scoped phone-uniqueness check', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockResolvedValueOnce({ id: 'c1' });
      await expect(service.create(TENANT, { phone: '+966500', email: 'a@b.com' } as any)).resolves.toEqual({ id: 'c1' });
    });

    it('rejects a duplicate phone within the tenant', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create(TENANT, { phone: '+966500' } as any)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });
  });

  describe('update', () => {
    it('updates fields and re-checks phone uniqueness on change', async () => {
      customers.findOne
        .mockResolvedValueOnce({ id: 'c1', phone: '+966500' }) // findOneOrThrow
        .mockResolvedValueOnce(null); // phone unique
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', { phone: '+966511', full_name: 'New' } as any);
      expect(res).toEqual(expect.objectContaining({ phone: '+966511', full_name: 'New' }));
    });

    it('throws when the customer does not exist', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      await expect(service.update(TENANT, 'x', {} as any)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('rejects an update to a phone already used by another customer', async () => {
      customers.findOne
        .mockResolvedValueOnce({ id: 'c1', phone: '+966500' })
        .mockResolvedValueOnce({ id: 'c2' }); // phone taken by another
      await expect(service.update(TENANT, 'c1', { phone: '+966511' } as any)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
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
      await expect(service.getDetails(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('findOneOrThrow returns the customer', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1' });
      await expect(service.findOneOrThrow(TENANT, 'c1')).resolves.toEqual({ id: 'c1' });
    });
  });

  describe('list / search', () => {
    it('lists customers with an active filter and pagination', async () => {
      customers.findAndCount.mockResolvedValueOnce([[{ id: 'c1' }], 1]);
      const res = await service.list(TENANT, { page: 1, limit: 10, isActive: true } as any);
      expect(res).toEqual({ data: [{ id: 'c1' }], total: 1, page: 1, limit: 10 });
    });

    it('search builds an OR (name/email/phone) when a query term is present', async () => {
      customers.findAndCount.mockResolvedValueOnce([[{ id: 'c1' }], 1]);
      await service.search(TENANT, { page: 1, limit: 10, q: 'ali', tagIds: ['tag1'] } as any);
      const arg = customers.findAndCount.mock.calls[0][0];
      expect(Array.isArray(arg.where)).toBe(true);
      expect(arg.where).toHaveLength(3);
    });

    it('search uses a single where object when no term is given', async () => {
      customers.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.search(TENANT, { page: 1, limit: 10 } as any);
      const arg = customers.findAndCount.mock.calls[0][0];
      expect(Array.isArray(arg.where)).toBe(false);
    });
  });
});
