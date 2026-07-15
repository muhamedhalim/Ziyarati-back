import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { Permission } from '../../entities/Auth&RBAC/Permission';
import { Role } from '../../entities/Auth&RBAC/Role';
import { AppError, ErrorCode } from '../../common/errors';
import { PermissionScope, RiskLevel } from '../../rbac/permission-metadata';

import { QueryPermissionsDto } from './dto/query-permissions.dto';
import { CompareRolesDto } from './dto/compare-roles.dto';
import { RbacAuditService, RbacFinding } from './rbac-audit.service';

// ─────────────────────────────── Output shapes ──────────────────────────── //

export interface PermissionRow {
  id: string;
  name: string;
  slug: string;
  module: string | null;
  description: string | null;
  scope: PermissionScope;
  risk: RiskLevel;
  status: 'active' | 'deprecated';
  deprecated: boolean;
  roleCount: number;
  effectiveUserCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionStats {
  totalPermissions: number;
  totalModules: number;
  assignedPermissions: number;
  unassignedPermissions: number;
  highRiskPermissions: number; // high + critical
  criticalPermissions: number;
  deprecatedPermissions: number;
  missingDescriptions: number;
}

export interface AssignedRoleSummary {
  id: string;
  name: string;
  slug: string;
  scope: 'platform' | 'tenant';
  isSystem: boolean;
  userCount: number;
}

export interface RelatedPermission {
  id: string;
  name: string;
  slug: string;
  risk: RiskLevel;
}

export interface PermissionDetails extends PermissionRow {
  assignedRoles: AssignedRoleSummary[];
  relatedPermissions: RelatedPermission[];
  warnings: RbacFinding[];
}

export interface ModuleSummary {
  module: string;
  total: number;
  assigned: number;
  unassigned: number;
  highRisk: number;
}

export interface RoleSummary {
  id: string;
  name: string;
  slug: string;
  scope: 'platform' | 'tenant';
  isSystem: boolean;
  permissionCount: number;
  userCount: number;
}

export interface ComparePermission {
  id: string;
  slug: string;
  name: string;
  module: string | null;
  risk: RiskLevel;
  scope: PermissionScope;
  deprecated: boolean;
  inA: boolean;
  inB: boolean;
}

export interface RoleComparison {
  roleA: { id: string; name: string; slug: string };
  roleB: { id: string; name: string; slug: string };
  shared: ComparePermission[];
  onlyA: ComparePermission[];
  onlyB: ComparePermission[];
  counts: { shared: number; onlyA: number; onlyB: number };
}

/** SQL fragment listing permission ids assigned to at least one non-deleted role. */
const ASSIGNED_SUBQUERY =
  'SELECT DISTINCT rpx."permissionId" AS pid FROM role_permissions rpx ' +
  'JOIN roles rx ON rx.id = rpx."roleId" AND rx.deleted_at IS NULL';

/** EXISTS clause reused by the assignment filter + stats. */
const ASSIGNED_EXISTS =
  'EXISTS (SELECT 1 FROM role_permissions rpe ' +
  'JOIN roles rxe ON rxe.id = rpe."roleId" AND rxe.deleted_at IS NULL ' +
  'WHERE rpe."permissionId" = p.id)';

/** Deterministic ORDER BY expression per whitelisted sort key. */
const SORT_EXPR: Record<string, string> = {
  name: 'p.name',
  slug: 'p.slug',
  module: 'p.module',
  scope: 'p.scope',
  risk: `CASE p.risk_level WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`,
  status: 'p.is_deprecated',
  roleCount: '"roleCount"',
  effectiveUserCount: '"userCount"',
  createdAt: 'p.created_at',
};

/**
 * Read-only Access-Control Audit reporting over the permission catalogue and
 * role/permission/user graph. Every aggregate is a grouped SQL query (no N+1,
 * no per-row queries); effective user counts use COUNT(DISTINCT) so a user with
 * multiple qualifying roles is counted once. Soft-deleted roles never
 * contribute to counts. Platform super-admin only (enforced at the controller).
 */
@Injectable()
export class PermissionsAuditService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    private readonly audit: RbacAuditService,
  ) {}

  // ───────────────────────────────── Stats ──────────────────────────────── //

  async stats(): Promise<PermissionStats> {
    const totals = await this.permissions
      .createQueryBuilder('p')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(DISTINCT p.module)', 'modules')
      .addSelect(`COUNT(*) FILTER (WHERE p.risk_level IN ('high','critical'))`, 'highRisk')
      .addSelect(`COUNT(*) FILTER (WHERE p.risk_level = 'critical')`, 'critical')
      .addSelect('COUNT(*) FILTER (WHERE p.is_deprecated)', 'deprecated')
      .addSelect(
        `COUNT(*) FILTER (WHERE p.description IS NULL OR p.description = '')`,
        'missing',
      )
      .getRawOne<{
        total: string;
        modules: string;
        highRisk: string;
        critical: string;
        deprecated: string;
        missing: string;
      }>();

    const assigned = await this.permissions
      .createQueryBuilder('p')
      .where(ASSIGNED_EXISTS)
      .getCount();

    const total = Number(totals?.total) || 0;
    return {
      totalPermissions: total,
      totalModules: Number(totals?.modules) || 0,
      assignedPermissions: assigned,
      unassignedPermissions: total - assigned,
      highRiskPermissions: Number(totals?.highRisk) || 0,
      criticalPermissions: Number(totals?.critical) || 0,
      deprecatedPermissions: Number(totals?.deprecated) || 0,
      missingDescriptions: Number(totals?.missing) || 0,
    };
  }

  // ───────────────────────────────── List ───────────────────────────────── //

  /** Applies filters (all parameterised) to a permissions query aliased `p`. */
  private applyFilters(
    qb: SelectQueryBuilder<Permission>,
    q: QueryPermissionsDto,
  ): void {
    if (q.search) {
      qb.andWhere(
        '(p.name ILIKE :s OR p.slug ILIKE :s OR p.description ILIKE :s)',
        { s: `%${q.search}%` },
      );
    }
    if (q.module) qb.andWhere('p.module = :module', { module: q.module });
    if (q.scope) qb.andWhere('p.scope = :scope', { scope: q.scope });
    if (q.risk) qb.andWhere('p.risk_level = :risk', { risk: q.risk });
    if (q.status === 'active') qb.andWhere('p.is_deprecated = false');
    if (q.status === 'deprecated') qb.andWhere('p.is_deprecated = true');
    if (q.assignment === 'assigned') qb.andWhere(ASSIGNED_EXISTS);
    if (q.assignment === 'unassigned') qb.andWhere(`NOT ${ASSIGNED_EXISTS}`);
    if (q.metadata === 'missing_description') {
      qb.andWhere(`(p.description IS NULL OR p.description = '')`);
    }
    if (q.metadata === 'complete') {
      qb.andWhere(`(p.description IS NOT NULL AND p.description <> '')`);
    }
  }

  async list(
    q: QueryPermissionsDto,
  ): Promise<{ data: PermissionRow[]; total: number; page: number; limit: number }> {
    // Count (filters only; no joins needed — filters are on permission columns).
    const countQb = this.permissions.createQueryBuilder('p');
    this.applyFilters(countQb, q);
    const total = await countQb.getCount();

    // Data (aggregate counts via explicit joins; grouped; sorted; paginated).
    const dataQb = this.permissions
      .createQueryBuilder('p')
      .leftJoin('role_permissions', 'rp', 'rp."permissionId" = p.id')
      .leftJoin('roles', 'r', 'r.id = rp."roleId" AND r.deleted_at IS NULL')
      .leftJoin('user_roles', 'ur', 'ur."roleId" = r.id')
      .select('p.id', 'p_id')
      .addSelect('p.name', 'p_name')
      .addSelect('p.slug', 'p_slug')
      .addSelect('p.module', 'p_module')
      .addSelect('p.description', 'p_description')
      .addSelect('p.scope', 'p_scope')
      .addSelect('p.risk_level', 'p_risk')
      .addSelect('p.is_deprecated', 'p_deprecated')
      .addSelect('p.created_at', 'p_created')
      .addSelect('p.updated_at', 'p_updated')
      .addSelect('COUNT(DISTINCT r.id)', 'roleCount')
      .addSelect('COUNT(DISTINCT ur."userId")', 'userCount')
      .groupBy('p.id');
    this.applyFilters(dataQb, q);

    const sortExpr = SORT_EXPR[q.sortBy] ?? SORT_EXPR.module;
    dataQb
      .orderBy(sortExpr, q.sortDir)
      .addOrderBy('p.name', 'ASC')
      .offset((q.page - 1) * q.limit)
      .limit(q.limit);

    const raw = await dataQb.getRawMany<{
      p_id: string;
      p_name: string;
      p_slug: string;
      p_module: string | null;
      p_description: string | null;
      p_scope: PermissionScope;
      p_risk: RiskLevel;
      p_deprecated: boolean;
      p_created: Date;
      p_updated: Date;
      roleCount: string;
      userCount: string;
    }>();

    const data: PermissionRow[] = raw.map((r) => ({
      id: r.p_id,
      name: r.p_name,
      slug: r.p_slug,
      module: r.p_module ?? null,
      description: r.p_description ?? null,
      scope: r.p_scope,
      risk: r.p_risk,
      status: r.p_deprecated ? 'deprecated' : 'active',
      deprecated: r.p_deprecated,
      roleCount: Number(r.roleCount) || 0,
      effectiveUserCount: Number(r.userCount) || 0,
      createdAt: r.p_created?.toISOString?.() ?? String(r.p_created),
      updatedAt: r.p_updated?.toISOString?.() ?? String(r.p_updated),
    }));

    return { data, total, page: q.page, limit: q.limit };
  }

  // ──────────────────────────────── Details ─────────────────────────────── //

  async details(id: string): Promise<PermissionDetails> {
    const permission = await this.permissions.findOne({ where: { id } });
    if (!permission) throw new AppError(ErrorCode.PERMISSION_NOT_FOUND);

    const assignedRoles = await this.roles
      .createQueryBuilder('r')
      .innerJoin('role_permissions', 'rp', 'rp."roleId" = r.id')
      .leftJoin('user_roles', 'ur', 'ur."roleId" = r.id')
      .select('r.id', 'id')
      .addSelect('r.name', 'name')
      .addSelect('r.slug', 'slug')
      .addSelect('r.is_system', 'isSystem')
      .addSelect('r."tenantId"', 'tenantId')
      .addSelect('COUNT(DISTINCT ur."userId")', 'userCount')
      .where('rp."permissionId" = :id', { id })
      .andWhere('r.deleted_at IS NULL')
      .groupBy('r.id')
      .orderBy('r.name', 'ASC')
      .getRawMany<{
        id: string;
        name: string;
        slug: string;
        isSystem: boolean;
        tenantId: string | null;
        userCount: string;
      }>();

    const effectiveUsers = await this.roles
      .createQueryBuilder('r')
      .innerJoin('role_permissions', 'rp', 'rp."roleId" = r.id')
      .innerJoin('user_roles', 'ur', 'ur."roleId" = r.id')
      .select('COUNT(DISTINCT ur."userId")', 'c')
      .where('rp."permissionId" = :id', { id })
      .andWhere('r.deleted_at IS NULL')
      .getRawOne<{ c: string }>();

    const related = permission.module
      ? await this.permissions
          .createQueryBuilder('p')
          .select(['p.id AS id', 'p.name AS name', 'p.slug AS slug', 'p.risk_level AS risk'])
          .where('p.module = :module', { module: permission.module })
          .andWhere('p.id <> :id', { id })
          .orderBy('p.name', 'ASC')
          .limit(25)
          .getRawMany<{ id: string; name: string; slug: string; risk: RiskLevel }>()
      : [];

    const warnings = await this.audit.findingsForPermission(id);

    return {
      id: permission.id,
      name: permission.name,
      slug: permission.slug,
      module: permission.module ?? null,
      description: permission.description ?? null,
      scope: permission.scope,
      risk: permission.risk_level,
      status: permission.is_deprecated ? 'deprecated' : 'active',
      deprecated: permission.is_deprecated,
      roleCount: assignedRoles.length,
      effectiveUserCount: Number(effectiveUsers?.c) || 0,
      createdAt: permission.created_at.toISOString(),
      updatedAt: permission.updated_at.toISOString(),
      assignedRoles: assignedRoles.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        scope: r.tenantId ? 'tenant' : 'platform',
        isSystem: r.isSystem,
        userCount: Number(r.userCount) || 0,
      })),
      relatedPermissions: related.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        risk: r.risk,
      })),
      warnings,
    };
  }

  // ──────────────────────────────── Modules ─────────────────────────────── //

  async modules(): Promise<ModuleSummary[]> {
    const rows = await this.permissions
      .createQueryBuilder('p')
      .leftJoin(`(${ASSIGNED_SUBQUERY})`, 'a', 'a.pid = p.id')
      .select('p.module', 'module')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COUNT(a.pid)', 'assigned')
      .addSelect(`COUNT(*) FILTER (WHERE p.risk_level IN ('high','critical'))`, 'highRisk')
      .groupBy('p.module')
      .orderBy('p.module', 'ASC')
      .getRawMany<{ module: string | null; total: string; assigned: string; highRisk: string }>();

    return rows.map((r) => {
      const total = Number(r.total) || 0;
      const assigned = Number(r.assigned) || 0;
      return {
        module: r.module ?? 'uncategorized',
        total,
        assigned,
        unassigned: total - assigned,
        highRisk: Number(r.highRisk) || 0,
      };
    });
  }

  // ────────────────────────────── Roles (compare selectors) ─────────────── //

  async listRoles(): Promise<RoleSummary[]> {
    const rows = await this.roles
      .createQueryBuilder('r')
      .leftJoin('role_permissions', 'rp', 'rp."roleId" = r.id')
      .leftJoin('user_roles', 'ur', 'ur."roleId" = r.id')
      .select('r.id', 'id')
      .addSelect('r.name', 'name')
      .addSelect('r.slug', 'slug')
      .addSelect('r.is_system', 'isSystem')
      .addSelect('r."tenantId"', 'tenantId')
      .addSelect('COUNT(DISTINCT rp."permissionId")', 'permissionCount')
      .addSelect('COUNT(DISTINCT ur."userId")', 'userCount')
      .where('r.deleted_at IS NULL')
      .groupBy('r.id')
      .orderBy('r.is_system', 'DESC')
      .addOrderBy('r.name', 'ASC')
      .getRawMany<{
        id: string;
        name: string;
        slug: string;
        isSystem: boolean;
        tenantId: string | null;
        permissionCount: string;
        userCount: string;
      }>();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      scope: r.tenantId ? 'tenant' : 'platform',
      isSystem: r.isSystem,
      permissionCount: Number(r.permissionCount) || 0,
      userCount: Number(r.userCount) || 0,
    }));
  }

  // ──────────────────────────────── Compare ─────────────────────────────── //

  private async loadRoleOrThrow(id: string): Promise<Role> {
    const role = await this.roles.findOne({ where: { id } });
    if (!role) throw new AppError(ErrorCode.ROLE_NOT_FOUND);
    return role;
  }

  private async permissionsForRole(roleId: string) {
    return this.permissions
      .createQueryBuilder('p')
      .innerJoin('role_permissions', 'rp', 'rp."permissionId" = p.id')
      .select([
        'p.id AS id',
        'p.slug AS slug',
        'p.name AS name',
        'p.module AS module',
        'p.risk_level AS risk',
        'p.scope AS scope',
        'p.is_deprecated AS deprecated',
      ])
      .where('rp."roleId" = :roleId', { roleId })
      .getRawMany<{
        id: string;
        slug: string;
        name: string;
        module: string | null;
        risk: RiskLevel;
        scope: PermissionScope;
        deprecated: boolean;
      }>();
  }

  async compareRoles(dto: CompareRolesDto): Promise<RoleComparison> {
    if (dto.roleA === dto.roleB) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Select two different roles to compare.',
      });
    }
    const [roleA, roleB] = await Promise.all([
      this.loadRoleOrThrow(dto.roleA),
      this.loadRoleOrThrow(dto.roleB),
    ]);
    const [permsA, permsB] = await Promise.all([
      this.permissionsForRole(dto.roleA),
      this.permissionsForRole(dto.roleB),
    ]);

    const bySlugA = new Map(permsA.map((p) => [p.slug, p]));
    const bySlugB = new Map(permsB.map((p) => [p.slug, p]));
    const allSlugs = new Set<string>([...bySlugA.keys(), ...bySlugB.keys()]);

    const shared: ComparePermission[] = [];
    const onlyA: ComparePermission[] = [];
    const onlyB: ComparePermission[] = [];

    for (const slug of allSlugs) {
      const a = bySlugA.get(slug);
      const b = bySlugB.get(slug);
      const src = a ?? b!;
      const row: ComparePermission = {
        id: src.id,
        slug: src.slug,
        name: src.name,
        module: src.module ?? null,
        risk: src.risk,
        scope: src.scope,
        deprecated: src.deprecated,
        inA: !!a,
        inB: !!b,
      };
      if (a && b) shared.push(row);
      else if (a) onlyA.push(row);
      else onlyB.push(row);
    }

    const byName = (x: ComparePermission, y: ComparePermission) =>
      (x.module ?? '').localeCompare(y.module ?? '') || x.slug.localeCompare(y.slug);
    shared.sort(byName);
    onlyA.sort(byName);
    onlyB.sort(byName);

    return {
      roleA: { id: roleA.id, name: roleA.name, slug: roleA.slug },
      roleB: { id: roleB.id, name: roleB.name, slug: roleB.slug },
      shared,
      onlyA,
      onlyB,
      counts: { shared: shared.length, onlyA: onlyA.length, onlyB: onlyB.length },
    };
  }
}
