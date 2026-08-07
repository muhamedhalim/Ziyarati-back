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

    // M-09/T157 gap-closure: recipient locale must be persisted at create time
    // (the only settable-by-staff signal, since customers have no
    // authenticated UI of their own to declare a locale — see data-model.md §2.6).
    it('[M-09] persists preferred_locale when provided', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        preferred_locale: 'ar',
      } as any);
      expect(res).toEqual(expect.objectContaining({ preferred_locale: 'ar' }));
    });

    it('[M-09] leaves preferred_locale undefined (not a guessed default) when omitted', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, { phone: '+966500', email: 'a@b.com' } as any);
      expect(res.preferred_locale).toBeUndefined();
    });

    it('persists chronic_diseases when has_chronic_diseases is true', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        has_chronic_diseases: true,
        chronic_diseases: 'Type 2 diabetes',
      } as any);
      expect(res).toEqual(
        expect.objectContaining({ has_chronic_diseases: true, chronic_diseases: 'Type 2 diabetes' }),
      );
    });

    it('rejects has_chronic_diseases=true without chronic_diseases (server-side, not just DTO)', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create(TENANT, {
          phone: '+966500',
          email: 'a@b.com',
          has_chronic_diseases: true,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(customers.save).not.toHaveBeenCalled();
    });

    it('forces chronic_diseases to null when has_chronic_diseases is false, even if a value was sent', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        has_chronic_diseases: false,
        chronic_diseases: 'should be ignored',
      } as any);
      expect(res.chronic_diseases).toBeNull();
    });

    it('defaults has_chronic_diseases to false and chronic_diseases to null when omitted', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, { phone: '+966500', email: 'a@b.com' } as any);
      expect(res.has_chronic_diseases).toBe(false);
      expect(res.chronic_diseases).toBeNull();
    });

    it('persists has_health_insurance when provided', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, {
        phone: '+966500',
        email: 'a@b.com',
        has_health_insurance: true,
      } as any);
      expect(res.has_health_insurance).toBe(true);
    });

    it('leaves has_health_insurance undefined (tri-state "never asked") when omitted', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.create(TENANT, { phone: '+966500', email: 'a@b.com' } as any);
      expect(res.has_health_insurance).toBeUndefined();
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

    it('[M-09] updates preferred_locale via the generic field loop', async () => {
      customers.findOne.mockResolvedValueOnce({ id: 'c1', phone: '+966500', preferred_locale: undefined });
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', { preferred_locale: 'ar' } as any);
      expect(res).toEqual(expect.objectContaining({ preferred_locale: 'ar' }));
    });

    it('clears chronic_diseases when editing from Yes to No, even if only the boolean is sent', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        has_chronic_diseases: true,
        chronic_diseases: 'Type 2 diabetes',
      });
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', { has_chronic_diseases: false } as any);
      expect(res.has_chronic_diseases).toBe(false);
      expect(res.chronic_diseases).toBeNull();
    });

    it('rejects switching has_chronic_diseases to true without supplying chronic_diseases', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        has_chronic_diseases: false,
        chronic_diseases: null,
      });
      await expect(
        service.update(TENANT, 'c1', { has_chronic_diseases: true } as any),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(customers.save).not.toHaveBeenCalled();
    });

    it('keeps existing chronic_diseases text on an update that does not touch either field', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'c1',
        phone: '+966500',
        has_chronic_diseases: true,
        chronic_diseases: 'Asthma',
      });
      customers.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.update(TENANT, 'c1', { full_name: 'New' } as any);
      expect(res.chronic_diseases).toBe('Asthma');
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

  describe('setInsuranceStatus', () => {
    it('writes has_health_insurance via a tenant-scoped targeted update', async () => {
      await service.setInsuranceStatus(TENANT, 'c1', true);
      expect(customers.update).toHaveBeenCalledWith(
        { id: 'c1', tenant: { id: TENANT } },
        { has_health_insurance: true },
      );
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
