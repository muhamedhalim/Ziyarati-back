import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerProfileService } from './customer-profile.service';
import { CustomerService } from './customer.service';
import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = 'c1';

describe('CustomerProfileService', () => {
  let service: CustomerProfileService;
  let profiles: MockRepository;
  let customers: { findOneOrThrow: jest.Mock };

  beforeEach(async () => {
    profiles = createMockRepository();
    customers = {
      findOneOrThrow: jest.fn().mockResolvedValue({ id: CUSTOMER }),
    };
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
    await expect(service.get(TENANT, CUSTOMER, true)).resolves.toEqual({
      id: 'p1',
    });
  });

  it('get throws when the profile is unset', async () => {
    profiles.findOne.mockResolvedValueOnce(null);
    await expect(service.get(TENANT, CUSTOMER, true)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('upsert creates a profile lazily on first write', async () => {
    profiles.findOne.mockResolvedValueOnce(null);
    profiles.create.mockReturnValueOnce({});
    profiles.save.mockImplementationOnce(async (p: any) => p);
    const res = await service.upsert(
      TENANT,
      CUSTOMER,
      { blood_type: 'O+' } as any,
      true,
    );
    expect(profiles.create).toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ blood_type: 'O+' }));
  });

  it('upsert updates an existing profile', async () => {
    profiles.findOne.mockResolvedValueOnce({ id: 'p1', blood_type: 'A+' });
    profiles.save.mockImplementationOnce(async (p: any) => p);
    const res = await service.upsert(
      TENANT,
      CUSTOMER,
      { blood_type: 'O+' } as any,
      true,
    );
    expect(profiles.create).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ blood_type: 'O+' }));
  });

  describe('T108 (spec 014, US6, FR-H010a — BREAKING) — the SAME boundary as getDetails, on this independent route', () => {
    const fullProfile = () => ({
      id: 'p1',
      medical_history: 'Appendectomy 2019',
      allergies: 'Penicillin',
      blood_type: 'O+',
      notes: 'Internal note',
      emergency_contact_name: 'Jane Doe',
      emergency_contact_phone: '+966500000000',
    });

    it('get strips the 4 clinical fields without clinical.records.read', async () => {
      profiles.findOne.mockResolvedValueOnce(fullProfile());
      const res = await service.get(TENANT, CUSTOMER, false);
      expect(res).not.toHaveProperty('medical_history');
      expect(res).not.toHaveProperty('allergies');
      expect(res).not.toHaveProperty('blood_type');
      expect(res).not.toHaveProperty('notes');
      expect(res).toMatchObject({ emergency_contact_name: 'Jane Doe' });
    });

    it('get returns every field WITH clinical.records.read', async () => {
      profiles.findOne.mockResolvedValueOnce(fullProfile());
      const res = await service.get(TENANT, CUSTOMER, true);
      expect(res).toMatchObject({ medical_history: 'Appendectomy 2019' });
    });

    it('upsert REFUSES (403) a clinical field without clinical.records.manage — never silently dropped', async () => {
      await expect(
        service.upsert(TENANT, CUSTOMER, { blood_type: 'O+' } as any, false),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(profiles.save).not.toHaveBeenCalled();
    });

    it('upsert still allows non-clinical fields (emergency contact) without clinical.records.manage', async () => {
      profiles.findOne.mockResolvedValueOnce({ id: 'p1' });
      profiles.save.mockImplementationOnce(async (p: any) => p);
      await expect(
        service.upsert(
          TENANT,
          CUSTOMER,
          { emergency_contact_name: 'Jane Doe' } as any,
          false,
        ),
      ).resolves.toMatchObject({ emergency_contact_name: 'Jane Doe' });
    });

    it('upsert allows a clinical field WITH clinical.records.manage', async () => {
      profiles.findOne.mockResolvedValueOnce({ id: 'p1' });
      profiles.save.mockImplementationOnce(async (p: any) => p);
      await expect(
        service.upsert(TENANT, CUSTOMER, { blood_type: 'O+' } as any, true),
      ).resolves.toMatchObject({ blood_type: 'O+' });
    });
  });
});
