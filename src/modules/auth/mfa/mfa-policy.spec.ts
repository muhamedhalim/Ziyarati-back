import { ROLE } from '../../../rbac/rbac.constants';
import { enforcementKey, mfaTier } from './mfa-policy';

const staff = (roles: string[], permissions: string[] = []) => ({
  tenantId: 't1',
  roles,
  permissions,
});

describe('mfaTier — approved role policy', () => {
  it.each([
    [ROLE.SUPER_ADMIN, null],
    [ROLE.PLATFORM_SUPPORT, null],
    [ROLE.PLATFORM_SALES, null],
    [ROLE.OWNER, 't1'],
    [ROLE.MANAGER, 't1'],
    [ROLE.BRANCH_MANAGER, 't1'],
  ])('%s is privileged', (role, tenantId) => {
    expect(mfaTier({ tenantId, roles: [role], permissions: [] })).toBe(
      'privileged',
    );
  });

  it('any tenant-less principal is a platform user and privileged', () => {
    expect(mfaTier({ tenantId: null, roles: [], permissions: [] })).toBe(
      'privileged',
    );
  });

  it.each([ROLE.DOCTOR, ROLE.NURSE])('%s is clinical', (role) => {
    expect(mfaTier(staff([role]))).toBe('clinical');
  });

  it('a receptionist is clinical only if granted clinical-records access', () => {
    expect(mfaTier(staff([ROLE.RECEPTIONIST]))).toBe('none');
    expect(mfaTier(staff([ROLE.RECEPTIONIST], ['clinical.records.read']))).toBe(
      'clinical',
    );
  });

  it('patients and the AI bot are never enforced', () => {
    expect(mfaTier(staff([ROLE.CUSTOMER]))).toBe('none');
    expect(mfaTier(staff([ROLE.AI_BOT], ['clinical.records.read']))).toBe(
      'none',
    );
  });

  it('privileged wins over clinical', () => {
    expect(mfaTier(staff([ROLE.OWNER, ROLE.DOCTOR]))).toBe('privileged');
  });

  it('maps tiers to their enforcement dates', () => {
    expect(enforcementKey('privileged')).toBe('MFA_ENFORCE_FROM');
    expect(enforcementKey('clinical')).toBe('MFA_ENFORCE_CLINICAL_FROM');
    expect(enforcementKey('none')).toBeNull();
  });
});
