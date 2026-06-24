import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';

import { PatientService } from './patient.service';
import { Patient } from '../../entities/Patients/Patient';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockJwtService,
  createMockConfigService,
  MockRepository,
} from '../../../test/utils/mock-factories';

jest.mock('bcryptjs');

describe('PatientService', () => {
  let service: PatientService;
  let patients: MockRepository;
  let jwt: ReturnType<typeof createMockJwtService>;
  const bcryptHash = bcrypt.hash as unknown as jest.Mock;

  beforeEach(async () => {
    patients = createMockRepository();
    jwt = createMockJwtService();
    bcryptHash.mockResolvedValue('hashed-pw');

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientService,
        { provide: getRepositoryToken(Patient), useValue: patients },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: createMockConfigService() },
      ],
    }).compile();
    service = moduleRef.get(PatientService);
  });

  afterEach(() => jest.clearAllMocks());

  const dto = {
    email: 'patient@example.com',
    phone: '+966500000000',
    fullName: 'Pat Ient',
    password: 'PatientPass1!',
  } as any;

  it('registers a B2C patient with a patient-typed token pair', async () => {
    patients.findOne.mockResolvedValueOnce(null);
    patients.save.mockResolvedValueOnce({
      id: 'patient-1',
      email: dto.email,
      full_name: dto.fullName,
    });

    const result = await service.registerPatient(dto);

    expect(bcryptHash).toHaveBeenCalledWith('PatientPass1!', 12);
    expect(result.patient).toEqual({
      id: 'patient-1',
      email: dto.email,
      fullName: dto.fullName,
      type: 'patient',
    });
    expect(result.accessToken).toBe('signed.jwt.token');
    // The access token must carry the isolating `type: 'patient'` claim.
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'patient-1', type: 'patient' }),
      expect.any(Object),
    );
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'patient_refresh' }),
      expect.any(Object),
    );
  });

  it('rejects a duplicate patient email', async () => {
    patients.findOne.mockResolvedValueOnce({ id: 'existing' });
    await expect(service.registerPatient(dto)).rejects.toMatchObject({
      code: ErrorCode.EMAIL_ALREADY_EXISTS,
    });
    expect(patients.save).not.toHaveBeenCalled();
  });
});
