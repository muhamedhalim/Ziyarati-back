import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PatientChangeWindowService } from './patient-change-window.service';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * Extracted from T027's cancellation-window tests — the shared rule FR-C007
 * and FR-R009 both depend on ("same basis").
 */
describe('PatientChangeWindowService (FR-C007 / FR-R009)', () => {
  let service: PatientChangeWindowService;
  let tenantSettings: MockRepository;

  beforeEach(async () => {
    tenantSettings = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientChangeWindowService,
        { provide: getRepositoryToken(TenantSetting), useValue: tenantSettings },
      ],
    }).compile();
    service = moduleRef.get(PatientChangeWindowService);
  });

  it('allows an action OUTSIDE the window', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({ cancellation_hours: 24 });
    const startAt = new Date(Date.now() + 48 * 3600_000);
    await expect(service.assertWithinWindow(TENANT, startAt)).resolves.toBeUndefined();
  });

  it('refuses an action INSIDE the window', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({ cancellation_hours: 24 });
    const startAt = new Date(Date.now() + 2 * 3600_000);
    await expect(service.assertWithinWindow(TENANT, startAt)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      publicContext: { blockedReason: 'WINDOW_CLOSED' },
    });
  });

  it('falls back to the 24h platform default when the clinic has no settings row', async () => {
    tenantSettings.findOne.mockResolvedValueOnce(null);
    await expect(service.getWindowHours(TENANT)).resolves.toBe(24);
  });
});
