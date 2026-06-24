import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerAddressService } from './customer-address.service';
import { CustomerService } from './customer.service';
import { CustomerAddress } from '../../entities/CRM/CustomerAddress';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = 'c1';

describe('CustomerAddressService', () => {
  let service: CustomerAddressService;
  let addresses: MockRepository;
  let customers: { findOneOrThrow: jest.Mock };

  beforeEach(async () => {
    addresses = createMockRepository();
    customers = { findOneOrThrow: jest.fn().mockResolvedValue({ id: CUSTOMER }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerAddressService,
        { provide: getRepositoryToken(CustomerAddress), useValue: addresses },
        { provide: CustomerService, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(CustomerAddressService);
  });

  afterEach(() => jest.clearAllMocks());

  it('adds an address and clears other defaults when is_default is set', async () => {
    addresses.save.mockResolvedValueOnce({ id: 'a1' });
    await service.add(TENANT, CUSTOMER, { address_line: 'X', is_default: true } as any);
    expect(addresses.update).toHaveBeenCalledWith(
      expect.objectContaining({ customer: { id: CUSTOMER } }),
      { is_default: false },
    );
  });

  it('does not clear defaults for a non-default address', async () => {
    addresses.save.mockResolvedValueOnce({ id: 'a1' });
    await service.add(TENANT, CUSTOMER, { address_line: 'X' } as any);
    expect(addresses.update).not.toHaveBeenCalled();
  });

  it('updates an address', async () => {
    addresses.findOne.mockResolvedValueOnce({ id: 'a1', label: 'Home' });
    addresses.save.mockImplementationOnce(async (a: any) => a);
    const res = await service.update(TENANT, CUSTOMER, 'a1', { label: 'Work' } as any);
    expect(res).toEqual(expect.objectContaining({ label: 'Work' }));
  });

  it('throws when the address does not exist', async () => {
    addresses.findOne.mockResolvedValueOnce(null);
    await expect(service.update(TENANT, CUSTOMER, 'x', {} as any)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('removes and lists addresses', async () => {
    addresses.findOne.mockResolvedValueOnce({ id: 'a1' });
    await expect(service.remove(TENANT, CUSTOMER, 'a1')).resolves.toEqual({ id: 'a1', deleted: true });

    addresses.find.mockResolvedValueOnce([{ id: 'a1' }]);
    await expect(service.list(TENANT, CUSTOMER)).resolves.toHaveLength(1);
  });
});
