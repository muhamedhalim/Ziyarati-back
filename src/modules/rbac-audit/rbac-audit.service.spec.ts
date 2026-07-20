import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Permission } from '../../entities/Auth&RBAC/Permission';
import { Role } from '../../entities/Auth&RBAC/Role';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { RbacAuditService } from './rbac-audit.service';

/** Builds a query-builder double whose getRawMany resolves the given rows. */
const qbReturning = (rows: unknown[]) => {
  const qb = createMockQueryBuilder();
  qb.getRawMany.mockResolvedValue(rows);
  return qb;
};

const PERMS = [
  { id: 'p-del', name: 'Delete services', slug: 'services.delete', module: 'services', description: 'x', scope: 'tenant', risk_level: 'high', is_deprecated: false },
  { id: 'p-tag', name: 'Read tags', slug: 'crm.tags.read', module: 'crm', description: null, scope: 'tenant', risk_level: 'low', is_deprecated: false },
  { id: 'p-cancel', name: 'Cancel', slug: 'appointments.cancel', module: 'appointments', description: 'x', scope: 'tenant', risk_level: 'medium', is_deprecated: true },
  { id: 'p-tman', name: 'Manage tenants', slug: 'tenants.manage', module: 'admin', description: 'x', scope: 'platform', risk_level: 'critical', is_deprecated: false },
  { id: 'p-ghost', name: 'Ghost', slug: 'ghost.permission', module: 'ghost', description: 'x', scope: 'tenant', risk_level: 'medium', is_deprecated: false },
];

const ROLES = [
  { id: 'r-tenant', name: 'Custom Ops', slug: 'custom_ops', is_system: false, tenantId: 't1', userCount: '3' },
  { id: 'r-sys', name: 'Super Admin', slug: 'super_admin', is_system: true, tenantId: null, userCount: '1' },
];

const ROLE_PERMS = [
  { roleId: 'r-tenant', permId: 'p-tag', slug: 'crm.tags.read', module: 'crm', scope: 'tenant', risk: 'low', deprecated: false },
  { roleId: 'r-tenant', permId: 'p-cancel', slug: 'appointments.cancel', module: 'appointments', scope: 'tenant', risk: 'medium', deprecated: true },
  { roleId: 'r-tenant', permId: 'p-tman', slug: 'tenants.manage', module: 'admin', scope: 'platform', risk: 'critical', deprecated: false },
  { roleId: 'r-sys', permId: 'p-tman', slug: 'tenants.manage', module: 'admin', scope: 'platform', risk: 'critical', deprecated: false },
];

describe('RbacAuditService', () => {
  let service: RbacAuditService;
  let perms: MockRepository;
  let roles: MockRepository;

  beforeEach(async () => {
    perms = createMockRepository();
    roles = createMockRepository();
    perms.find.mockResolvedValue(PERMS);
    perms.createQueryBuilder.mockReturnValue(qbReturning(ROLE_PERMS)); // loadRolePerms
    roles.createQueryBuilder.mockReturnValue(qbReturning(ROLES)); // loadRoles

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RbacAuditService,
        { provide: getRepositoryToken(Permission), useValue: perms },
        { provide: getRepositoryToken(Role), useValue: roles },
      ],
    }).compile();
    service = moduleRef.get(RbacAuditService);
  });

  afterEach(() => jest.clearAllMocks());

  const has = (
    list: Awaited<ReturnType<RbacAuditService['buildFindings']>>,
    match: Partial<{ code: string; permissionSlug: string; roleId: string; permissionId: string }>,
  ) => list.some((f) => Object.entries(match).every(([k, v]) => (f as unknown as Record<string, unknown>)[k] === v));

  it('flags unassigned permissions', async () => {
    const f = await service.buildFindings();
    expect(has(f, { code: 'PERMISSION_UNASSIGNED', permissionId: 'p-del' })).toBe(true);
  });

  it('flags permissions with no description', async () => {
    const f = await service.buildFindings();
    expect(has(f, { code: 'PERMISSION_NO_DESCRIPTION', permissionSlug: 'crm.tags.read' })).toBe(true);
  });

  it('flags a deprecated permission that is still assigned', async () => {
    const f = await service.buildFindings();
    expect(
      has(f, { code: 'DEPRECATED_PERMISSION_ASSIGNED', permissionSlug: 'appointments.cancel', roleId: 'r-tenant' }),
    ).toBe(true);
  });

  it('flags a critical permission on a tenant role but NOT on a system role', async () => {
    const f = await service.buildFindings();
    expect(
      has(f, { code: 'CRITICAL_ON_TENANT_ROLE', permissionSlug: 'tenants.manage', roleId: 'r-tenant' }),
    ).toBe(true);
    expect(has(f, { code: 'CRITICAL_ON_TENANT_ROLE', roleId: 'r-sys' })).toBe(false);
  });

  it('flags a platform-scoped permission on a tenant role (scope mismatch)', async () => {
    const f = await service.buildFindings();
    expect(
      has(f, { code: 'ROLE_SCOPE_MISMATCH', permissionSlug: 'tenants.manage', roleId: 'r-tenant' }),
    ).toBe(true);
  });

  it('flags a database permission missing from the registry', async () => {
    const f = await service.buildFindings();
    expect(has(f, { code: 'PERMISSION_MISSING_FROM_REGISTRY', permissionSlug: 'ghost.permission' })).toBe(true);
  });

  it('does not raise a broad-assignment finding below the user threshold', async () => {
    const f = await service.buildFindings();
    expect(has(f, { code: 'HIGH_RISK_BROAD_ASSIGNMENT' })).toBe(false);
  });

  it('filters findings by severity and preserves severity counts', async () => {
    const res = await service.findings({ severity: 'high' });
    expect(res.data.every((f) => f.severity === 'high')).toBe(true);
    expect(res.countsBySeverity.high).toBeGreaterThanOrEqual(res.data.length);
    const total =
      res.countsBySeverity.info +
      res.countsBySeverity.warning +
      res.countsBySeverity.high +
      res.countsBySeverity.critical;
    expect(total).toBeGreaterThan(res.data.length);
  });

  it('filters findings by code', async () => {
    const res = await service.findings({ code: 'PERMISSION_UNASSIGNED' });
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.every((f) => f.code === 'PERMISSION_UNASSIGNED')).toBe(true);
  });

  it('returns only findings for a specific permission id', async () => {
    const list = await service.findingsForPermission('p-del');
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((f) => f.permissionId === 'p-del')).toBe(true);
  });
});
