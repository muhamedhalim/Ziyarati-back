import { PlatformAiMonitoringController } from './platform-ai-monitoring.controller';
import { ROLE } from '../../rbac/rbac.constants';
import { classRoles, guardNames } from '../../../test/utils/route-metadata';

describe('PlatformAiMonitoringController', () => {
  it('is super-admin only, enforced by RolesGuard', () => {
    expect(classRoles(PlatformAiMonitoringController)).toEqual([ROLE.SUPER_ADMIN]);
    expect(guardNames(PlatformAiMonitoringController)).toContain('RolesGuard');
  });

  it('overview returns exactly what the monitoring service computed, with no extra parameters', async () => {
    const snapshot = { requests: 1 };
    const monitoring = { overview: jest.fn().mockResolvedValue(snapshot) };
    const controller = new PlatformAiMonitoringController(monitoring as never);

    await expect(controller.overview()).resolves.toBe(snapshot);
    expect(monitoring.overview).toHaveBeenCalledWith();
  });
});
