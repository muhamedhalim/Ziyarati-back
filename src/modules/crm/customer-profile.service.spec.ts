import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerProfileService } from './customer-profile.service';
import { CustomerService } from './customer.service';
import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = 'c1';

describe('CustomerProfileService', () => {
  let service: CustomerProfileService;
  let profiles: MockRepository;
  let customers: { findOneOrThrow: jest.Mock };

  beforeEach(async () => {
    profiles = createMockRepository();
    customers = { findOneOrThrow: jest.fn().mockResolvedValue({ id: CUSTOMER }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerProfileService,
        { provide: getRepositoryToken(CustomerProfile), useValue: profiles },
        { provide: CustomerService, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(CustomerProfileService);
  });

  afterEach(() => jest.clearAllMocks());

  it('get returns an existing profile', async () => {
    profiles.findOne.mockResolvedValueOnce({ id: 'p1' });
    await expect(service.get(TENANT, CUSTOMER)).resolves.toEqual({ id: 'p1' });
  });

  it('get throws when the profile is unset', async () => {
    profiles.findOne.mockResolvedValueOnce(null);
    await expect(service.get(TENANT, CUSTOMER)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('upsert creates a profile lazily on first write', async () => {
    profiles.findOne.mockResolvedValueOnce(null);
    profiles.create.mockReturnValueOnce({});
    profiles.save.mockImplementationOnce(async (p: any) => p);
    const res = await service.upsert(TENANT, CUSTOMER, { blood_type: 'O+' } as any);
    expect(profiles.create).toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ blood_type: 'O+' }));
  });

  it('upsert updates an existing profile', async () => {
    profiles.findOne.mockResolvedValueOnce({ id: 'p1', blood_type: 'A+' });
    profiles.save.mockImplementationOnce(async (p: any) => p);
    const res = await service.upsert(TENANT, CUSTOMER, { blood_type: 'O+' } as any);
    expect(profiles.create).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ blood_type: 'O+' }));
  });
});
