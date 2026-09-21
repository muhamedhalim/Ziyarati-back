import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PatientChangeWindowService, isWithinChangeWindow } from './patient-change-window.service';
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

  // F-05 (Phase 2): the AI cancel/reschedule path applies the SAME rule through this pure predicate.
  describe('isWithinChangeWindow', () => {
    const NOW = Date.parse('2026-09-21T10:00:00Z');
    const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3600_000);

    it('is true well outside the window and false well inside it', () => {
      expect(isWithinChangeWindow(at(48), 24, NOW)).toBe(true);
      expect(isWithinChangeWindow(at(2), 24, NOW)).toBe(false);
    });

    it('treats exactly N hours before the start as still allowed, and one millisecond later as closed', () => {
      expect(isWithinChangeWindow(at(24), 24, NOW)).toBe(true);
      expect(isWithinChangeWindow(at(24), 24, NOW + 1)).toBe(false);
    });

    it('a zero-hour window closes at the start time; a start in the past is always closed', () => {
      expect(isWithinChangeWindow(at(0), 0, NOW)).toBe(true);
      expect(isWithinChangeWindow(at(-1), 0, NOW)).toBe(false);
      expect(isWithinChangeWindow(at(-1), 24, NOW)).toBe(false);
    });

    it('agrees with assertWithinWindow — one rule, two callers', async () => {
      for (const hours of [1, 24, 72]) {
        for (const ahead of [0.5, 23, 25, 100]) {
          tenantSettings.findOne.mockResolvedValueOnce({ cancellation_hours: hours });
          const start = new Date(Date.now() + ahead * 3600_000);
          const allowed = await service.assertWithinWindow(TENANT, start).then(() => true, () => false);
          expect(allowed).toBe(isWithinChangeWindow(start, hours));
        }
      }
    });
  });
});
