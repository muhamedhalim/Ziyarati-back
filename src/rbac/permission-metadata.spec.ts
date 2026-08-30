import { PERMISSION } from './rbac.constants';
import {
  DEFAULT_RISK,
  getPermissionMetadata,
  getRisk,
  getScope,
  RISK_LEVELS,
} from './permission-metadata';

describe('permission-metadata', () => {
  describe('getRisk', () => {
    it('classifies explicitly-mapped critical permissions', () => {
      expect(getRisk(PERMISSION.TENANTS_MANAGE)).toBe('critical');
      expect(getRisk(PERMISSION.ROLES_MANAGE)).toBe('critical');
      expect(getRisk(PERMISSION.REFUNDS_MANAGE)).toBe('critical');
    });

    it('classifies explicitly-mapped high permissions', () => {
      expect(getRisk(PERMISSION.SERVICES_DELETE)).toBe('high');
      expect(getRisk(PERMISSION.PAYMENTS_MANAGE)).toBe('high');
    });

    it('defaults read/self-service permissions to low', () => {
      expect(getRisk(PERMISSION.APPOINTMENTS_READ)).toBe('low');
      expect(getRisk(PERMISSION.APPOINTMENTS_READ_OWN)).toBe('low');
      expect(getRisk(PERMISSION.PROFILE_UPDATE_OWN)).toBe('low');
      expect(getRisk(PERMISSION.CUSTOMERS_READ)).toBe('low');
    });

    it('defaults unmapped write/manage permissions to the safe default, never high', () => {
      // A create action with no explicit override.
      expect(getRisk(PERMISSION.APPOINTMENTS_CREATE)).toBe(DEFAULT_RISK);
      expect(DEFAULT_RISK).toBe('medium');
    });

    it('classifies the T003 clinical/audit slugs (spec 014)', () => {
      expect(getRisk(PERMISSION.CLINICAL_RECORDS_READ)).toBe('high');
      expect(getRisk(PERMISSION.CLINICAL_RECORDS_MANAGE)).toBe('high');
      expect(getRisk(PERMISSION.AUDIT_READ)).toBe('medium');
    });

    it('never silently classifies an unmapped permission as high or critical', () => {
      const highRisk = new Set(['high', 'critical']);
      // Every permission that is NOT in the explicit override set must resolve
      // to low or medium.
      const derived = getRisk(PERMISSION.NOTIFICATIONS_READ);
      expect(highRisk.has(derived)).toBe(false);
      expect(RISK_LEVELS).toContain(derived);
    });
  });

  describe('getScope', () => {
    it('infers platform scope for the platform namespace', () => {
      expect(getScope(PERMISSION.PLATFORM_SETTINGS_MANAGE)).toBe('platform');
      expect(getScope(PERMISSION.PLATFORM_API_KEYS_READ)).toBe('platform');
    });

    it('treats tenants.manage as a platform-scoped permission', () => {
      expect(getScope(PERMISSION.TENANTS_MANAGE)).toBe('platform');
    });

    it('defaults everything else to tenant scope', () => {
      expect(getScope(PERMISSION.APPOINTMENTS_CREATE)).toBe('tenant');
      expect(getScope(PERMISSION.USERS_MANAGE)).toBe('tenant');
    });
  });

  describe('getPermissionMetadata', () => {
    it('bundles description, scope, risk and deprecated', () => {
      const meta = getPermissionMetadata(PERMISSION.REFUNDS_MANAGE);
      expect(meta).toEqual({
        description: expect.any(String),
        scope: 'tenant',
        risk: 'critical',
        deprecated: false,
      });
    });

    it('returns null description for undescribed permissions', () => {
      const meta = getPermissionMetadata(PERMISSION.CRM_TAGS_READ);
      expect(meta.description).toBeNull();
      expect(meta.risk).toBe('low');
    });
  });
});
