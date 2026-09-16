/**
 * `@PrivateCache` + `@RequireAnyPermission` WIRING — read directly off the
 * controller class (mirrors `advanced-analytics.private-cache.spec.ts`).
 * No DB, no HTTP.
 */
import 'reflect-metadata';
import { PRIVATE_CACHE_KEY } from '../../../common/http/private-cache.decorator';
import { ANY_PERMISSIONS_KEY } from '../../auth/decorators/require-any-permission.decorator';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { PatientJourneyController } from './patient-journey.controller';
import { ANALYTICS_MAX_AGE_SECONDS } from '../advanced-analytics.controller';

function maxAgeOf(methodName: keyof PatientJourneyController) {
  return Reflect.getMetadata(
    PRIVATE_CACHE_KEY,
    PatientJourneyController.prototype[methodName],
  ) as number | undefined;
}

function permissionsOf(methodName: keyof PatientJourneyController) {
  return Reflect.getMetadata(
    ANY_PERMISSIONS_KEY,
    PatientJourneyController.prototype[methodName],
  ) as string[] | undefined;
}

describe('PatientJourneyController — decorator wiring', () => {
  it.each(['summary', 'breakdown'] as const)(
    '%s carries the shared analytics @PrivateCache budget',
    (method) => {
      expect(maxAgeOf(method)).toBe(ANALYTICS_MAX_AGE_SECONDS);
    },
  );

  it.each(['summary', 'breakdown'] as const)(
    '%s requires analytics.dashboard.read OR analytics.reports.read',
    (method) => {
      expect(permissionsOf(method)).toEqual([
        PERMISSION.ANALYTICS_DASHBOARD_READ,
        PERMISSION.ANALYTICS_REPORTS_READ,
      ]);
    },
  );
});
