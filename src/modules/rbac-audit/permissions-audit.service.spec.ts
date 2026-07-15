import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';

import { Permission } from '../../entities/Auth&RBAC/Permission';
import { Role } from '../../entities/Auth&RBAC/Role';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { PermissionsAuditService } from './permissions-audit.service';
import { RbacAuditService } from './rbac-audit.service';
import { QueryPermissionsDto } from './dto/query-permissions.dto';

describe('PermissionsAuditService', () => {
  let service: PermissionsAuditService;
  let perms: MockRepository;
  let roles: MockRepository;
  const audit = { findingsForPermission: jest.fn(async () => []) };

  beforeEach(async () => {
    perms = createMockRepository();
    roles = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionsAuditService,
        { provide: getRepositoryToken(Permission), useValue: perms },
        { provide: getRepositoryToken(Role), useValue: roles },
        { provide: RbacAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(PermissionsAuditService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('stats', () => {
    it('derives unassigned from total minus assigned and coerces raw strings', async () => {
      const totalsQb = createMockQueryBuilder();
      totalsQb.getRawOne.mockResolvedValue({
        total: '10', modules: '4', highRisk: '3', critical: '1', deprecated: '2', missing: '5',
      });
      const assignedQb = createMockQueryBuilder();
      assignedQb.getCount.mockResolvedValue(7);
      perms.createQueryBuilder
        .mockReturnValueOnce(totalsQb)
        .mockReturnValueOnce(assignedQb);

      const stats = await service.stats();
      expect(stats).toEqual({
        totalPermissions: 10,
        totalModules: 4,
        assignedPermissions: 7,
        unassignedPermissions: 3,
        highRiskPermissions: 3,
        criticalPermissions: 1,
        deprecatedPermissions: 2,
        missingDescriptions: 5,
      });
    });
  });

  describe('list', () => {
    it('maps rows, derives status, and counts distinct effective users', async () => {
      const countQb = createMockQueryBuilder();
      countQb.getCount.mockResolvedValue(2);
      const dataQb = createMockQueryBuilder();
      dataQb.getRawMany.mockResolvedValue([
        { p_id: 'p1', p_name: 'Read', p_slug: 'a.read', p_module: 'm', p_description: null, p_scope: 'tenant', p_risk: 'low', p_deprecated: false, p_created: new Date('2024-01-01T00:00:00Z'), p_updated: new Date('2024-01-02T00:00:00Z'), roleCount: '2', userCount: '5' },
        { p_id: 'p2', p_name: 'Delete', p_slug: 'a.delete', p_module: 'm', p_description: 'x', p_scope: 'tenant', p_risk: 'high', p_deprecated: true, p_created: new Date('2024-01-01T00:00:00Z'), p_updated: new Date('2024-01-02T00:00:00Z'), roleCount: '0', userCount: '0' },
      ]);
      perms.createQueryBuilder
        .mockReturnValueOnce(countQb)
        .mockReturnValueOnce(dataQb);

      const res = await service.list(plainToInstance(QueryPermissionsDto, {}));

      expect(res.total).toBe(2);
      expect(res.data[0]).toMatchObject({
        id: 'p1', slug: 'a.read', status: 'active', roleCount: 2, effectiveUserCount: 5,
      });
      expect(res.data[1].status).toBe('deprecated');

      // Distinct effective-user counting must be wired into the SQL.
      const distinctSelected = (dataQb as MockQueryBuilder).addSelect.mock.calls
        .some((c) => String(c[0]).includes('COUNT(DISTINCT ur."userId")'));
      expect(distinctSelected).toBe(true);
    });
  });

  describe('compareRoles', () => {
    it('rejects comparing a role with itself', async () => {
      await expect(
        service.compareRoles({ roleA: 'same', roleB: 'same' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('rejects when a role does not exist', async () => {
      roles.findOne.mockResolvedValueOnce(null); // roleA missing
      roles.findOne.mockResolvedValueOnce({ id: 'b', name: 'B', slug: 'b' });
      await expect(
        service.compareRoles({ roleA: 'a', roleB: 'b' }),
      ).rejects.toMatchObject({ code: ErrorCode.ROLE_NOT_FOUND });
    });

    it('splits permissions into shared / only-A / only-B', async () => {
      roles.findOne
        .mockResolvedValueOnce({ id: 'a', name: 'Role A', slug: 'role_a' })
        .mockResolvedValueOnce({ id: 'b', name: 'Role B', slug: 'role_b' });

      const permsA = createMockQueryBuilder();
      permsA.getRawMany.mockResolvedValue([
        { id: 'p1', slug: 'users.read', name: 'Read', module: 'users', risk: 'low', scope: 'tenant', deprecated: false },
        { id: 'p2', slug: 'users.create', name: 'Create', module: 'users', risk: 'medium', scope: 'tenant', deprecated: false },
      ]);
      const permsB = createMockQueryBuilder();
      permsB.getRawMany.mockResolvedValue([
        { id: 'p1', slug: 'users.read', name: 'Read', module: 'users', risk: 'low', scope: 'tenant', deprecated: false },
        { id: 'p3', slug: 'billing.refund', name: 'Refund', module: 'billing', risk: 'critical', scope: 'tenant', deprecated: false },
      ]);
      perms.createQueryBuilder
        .mockReturnValueOnce(permsA)
        .mockReturnValueOnce(permsB);

      const res = await service.compareRoles({ roleA: 'a', roleB: 'b' });

      expect(res.counts).toEqual({ shared: 1, onlyA: 1, onlyB: 1 });
      expect(res.shared.map((p) => p.slug)).toEqual(['users.read']);
      expect(res.onlyA.map((p) => p.slug)).toEqual(['users.create']);
      expect(res.onlyB.map((p) => p.slug)).toEqual(['billing.refund']);
    });
  });
});
