import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ClinicalAccessLogService } from './clinical-access-log.service';
import { ClinicalAccessLog } from '../../entities/Clinical/ClinicalAccessLog';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('ClinicalAccessLogService (T110 — FR-H011, FR-H012)', () => {
  let service: ClinicalAccessLogService;
  let accessLogs: MockRepository;

  beforeEach(async () => {
    accessLogs = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ClinicalAccessLogService,
        {
          provide: getRepositoryToken(ClinicalAccessLog),
          useValue: accessLogs,
        },
      ],
    }).compile();
    service = moduleRef.get(ClinicalAccessLogService);
  });

  afterEach(() => jest.clearAllMocks());

  it('records who read which patient, when, and at what scope', async () => {
    await service.record('tenant-1', 'customer-1', 'user-1', 'timeline');
    expect(accessLogs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: { id: 'tenant-1' },
        customer: { id: 'customer-1' },
        user: { id: 'user-1' },
        scope: 'timeline',
      }),
    );
  });

  it('records the specific entry when scope is "entry"', async () => {
    await service.record(
      'tenant-1',
      'customer-1',
      'user-1',
      'entry',
      'entry-1',
    );
    expect(accessLogs.save).toHaveBeenCalledWith(
      expect.objectContaining({ entry: { id: 'entry-1' } }),
    );
  });

  it('is best-effort — a write failure never throws to the caller', async () => {
    accessLogs.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record('tenant-1', 'customer-1', 'user-1', 'summary'),
    ).resolves.toBeUndefined();
  });
});
