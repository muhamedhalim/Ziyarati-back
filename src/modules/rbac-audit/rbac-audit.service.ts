import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Permission } from '../../entities/Auth&RBAC/Permission';
import { Role } from '../../entities/Auth&RBAC/Role';
import { ALL_PERMISSION_SLUGS, PERMISSION, PermissionSlug } from '../../rbac/rbac.constants';
import { getPermissionMetadata } from '../../rbac/permission-metadata';
import { AuditFindingCode, AuditSeverity, QueryAuditDto } from './dto/query-audit.dto';

/** A single RBAC audit finding (read-only; no state is mutated). */
export interface RbacFinding {
  code: AuditFindingCode;
  severity: AuditSeverity;
  title: string;
  description: string;
  permissionId: string | null;
  permissionSlug: string | null;
  roleId: string | null;
  roleName: string | null;
  module: string | null;
  remediation: string;
  autoFixable: boolean;
}

/**
 * A role holding a high/critical permission is considered "broad" (wider blast
 * radius) once it is granted to at least this many distinct users. Documented,
 * deterministic threshold — not a per-request guess.
 */
const BROAD_ROLE_USER_THRESHOLD = 10;

/**
 * Combinations of permissions that are individually legitimate but dangerous
 * together (privilege-escalation paths). Matched by slug; a role holding EVERY
 * slug in a group triggers the finding.
 */
const DANGEROUS_COMBINATIONS: { slugs: PermissionSlug[]; reason: string }[] = [
  {
    slugs: [PERMISSION.ROLES_MANAGE, PERMISSION.USERS_MANAGE],
    reason:
      'holds both user management and role management — it can create a user and grant it any permission (self-escalation path).',
  },
];

interface RoleRow {
  id: string;
  name: string;
  slug: string;
  is_system: boolean;
  tenantId: string | null;
  userCount: number;
}

interface RolePermRow {
  roleId: string;
  permId: string;
  slug: string;
  module: string | null;
  scope: string;
  risk: string;
  deprecated: boolean;
}

/**
 * Read-only RBAC audit engine. Computes findings across the whole permission /
 * role / role-permission graph from a handful of grouped queries (no N+1, no
 * per-row queries) and classifies them into stable finding codes. The first
 * version is intentionally read-only — no automatic mutation of grants.
 */
@Injectable()
export class RbacAuditService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
  ) {}

  /** Loads roles (non-deleted) with their distinct user counts. */
  private async loadRoles(): Promise<RoleRow[]> {
    const rows = await this.roles
      .createQueryBuilder('r')
      .leftJoin('user_roles', 'ur', 'ur."roleId" = r.id')
      .select('r.id', 'id')
      .addSelect('r.name', 'name')
      .addSelect('r.slug', 'slug')
      .addSelect('r.is_system', 'is_system')
      .addSelect('r."tenantId"', 'tenantId')
      .addSelect('COUNT(DISTINCT ur."userId")', 'userCount')
      .where('r.deleted_at IS NULL')
      .groupBy('r.id')
      .getRawMany<{
        id: string;
        name: string;
        slug: string;
        is_system: boolean;
        tenantId: string | null;
        userCount: string;
      }>();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      is_system: r.is_system,
      tenantId: r.tenantId,
      userCount: Number(r.userCount) || 0,
    }));
  }

  /** Loads every (role, permission) grant for non-deleted roles. */
  private async loadRolePerms(): Promise<RolePermRow[]> {
    const rows = await this.permissions
      .createQueryBuilder('p')
      .innerJoin('role_permissions', 'rp', 'rp."permissionId" = p.id')
      .innerJoin('roles', 'r', 'r.id = rp."roleId" AND r.deleted_at IS NULL')
      .select('r.id', 'roleId')
      .addSelect('p.id', 'permId')
      .addSelect('p.slug', 'slug')
      .addSelect('p.module', 'module')
      .addSelect('p.scope', 'scope')
      .addSelect('p.risk_level', 'risk')
      .addSelect('p.is_deprecated', 'deprecated')
      .getRawMany<{
        roleId: string;
        permId: string;
        slug: string;
        module: string | null;
        scope: string;
        risk: string;
        deprecated: boolean;
      }>();
    return rows.map((r) => ({
      roleId: r.roleId,
      permId: r.permId,
      slug: r.slug,
      module: r.module,
      scope: r.scope,
      risk: r.risk,
      deprecated: r.deprecated,
    }));
  }

  /** Computes the full set of findings (unfiltered). */
  async buildFindings(): Promise<RbacFinding[]> {
    const [dbPermissions, roles, rolePerms] = await Promise.all([
      this.permissions.find(),
      this.loadRoles(),
      this.loadRolePerms(),
    ]);

    const findings: RbacFinding[] = [];
    const registrySlugs = new Set<string>(ALL_PERMISSION_SLUGS);
    const dbSlugs = new Set(dbPermissions.map((p) => p.slug));

    const assignedPermIds = new Set(rolePerms.map((rp) => rp.permId));
    const rolesById = new Map(roles.map((r) => [r.id, r]));
    const permsByRole = new Map<string, RolePermRow[]>();
    for (const rp of rolePerms) {
      const list = permsByRole.get(rp.roleId) ?? [];
      list.push(rp);
      permsByRole.set(rp.roleId, list);
    }

    // ── Permission-level findings ──────────────────────────────────────────
    for (const p of dbPermissions) {
      const inRegistry = registrySlugs.has(p.slug);

      if (!assignedPermIds.has(p.id)) {
        findings.push({
          code: 'PERMISSION_UNASSIGNED',
          severity: 'warning',
          title: 'Permission not assigned to any role',
          description: `"${p.slug}" exists in the catalogue but no active role grants it.`,
          permissionId: p.id,
          permissionSlug: p.slug,
          roleId: null,
          roleName: null,
          module: p.module ?? null,
          remediation:
            'Confirm the permission is still referenced by code/guards, then either assign it to a role or plan its removal via the registry + a migration. Do not delete blindly.',
          autoFixable: false,
        });
      }

      if (!p.description || p.description.trim() === '') {
        findings.push({
          code: 'PERMISSION_NO_DESCRIPTION',
          severity: 'info',
          title: 'Permission has no description',
          description: `"${p.slug}" is missing an admin-facing description.`,
          permissionId: p.id,
          permissionSlug: p.slug,
          roleId: null,
          roleName: null,
          module: p.module ?? null,
          remediation:
            'Add a description in PERMISSION_DESCRIPTIONS (permission-metadata.ts) and re-run the permissions seeder.',
          autoFixable: false,
        });
      }

      if (!inRegistry) {
        findings.push({
          code: 'PERMISSION_MISSING_FROM_REGISTRY',
          severity: 'high',
          title: 'Permission in database is missing from the registry',
          description: `"${p.slug}" is persisted but is not declared in rbac.constants.ts (ALL_PERMISSION_SLUGS). It is effectively unmanaged.`,
          permissionId: p.id,
          permissionSlug: p.slug,
          roleId: null,
          roleName: null,
          module: p.module ?? null,
          remediation:
            'Either add the slug to the RBAC contract (if still used) or remove the stray row through a reviewed migration.',
          autoFixable: false,
        });
      } else {
        // Metadata drift: persisted value differs from the reviewed registry.
        const meta = getPermissionMetadata(p.slug as PermissionSlug);
        const drifted =
          p.scope !== meta.scope ||
          p.risk_level !== meta.risk ||
          p.is_deprecated !== meta.deprecated ||
          (p.description ?? null) !== meta.description;
        if (drifted) {
          findings.push({
            code: 'INCONSISTENT_PERMISSION_METADATA',
            severity: 'info',
            title: 'Persisted metadata differs from the registry',
            description: `"${p.slug}" has database metadata that no longer matches the reviewed registry classification.`,
            permissionId: p.id,
            permissionSlug: p.slug,
            roleId: null,
            roleName: null,
            module: p.module ?? null,
            remediation: 'Re-run the permissions seeder to reconcile the persisted metadata.',
            autoFixable: true,
          });
        }
      }
    }

    // Registry slugs with no DB row.
    for (const slug of registrySlugs) {
      if (!dbSlugs.has(slug)) {
        findings.push({
          code: 'PERMISSION_MISSING_FROM_DATABASE',
          severity: 'warning',
          title: 'Registry permission is missing from the database',
          description: `"${slug}" is declared in the RBAC contract but has no permissions row — guards referencing it will deny everyone.`,
          permissionId: null,
          permissionSlug: slug,
          roleId: null,
          roleName: null,
          module: null,
          remediation: 'Run the permissions seeder to insert the missing catalogue row.',
          autoFixable: true,
        });
      }
    }

    // ── Role / grant-level findings ────────────────────────────────────────
    for (const [roleId, perms] of permsByRole) {
      const role = rolesById.get(roleId);
      if (!role) continue;
      const isTenantScoped = role.tenantId !== null;

      for (const rp of perms) {
        if (rp.deprecated) {
          findings.push({
            code: 'DEPRECATED_PERMISSION_ASSIGNED',
            severity: 'high',
            title: 'Deprecated permission is still assigned',
            description: `Role "${role.name}" still grants the deprecated permission "${rp.slug}".`,
            permissionId: rp.permId,
            permissionSlug: rp.slug,
            roleId: role.id,
            roleName: role.name,
            module: rp.module,
            remediation:
              'Plan a migration to move roles off this permission before removing the slug. Never auto-remove without an administrative decision.',
            autoFixable: false,
          });
        }

        if (rp.risk === 'critical' && isTenantScoped) {
          findings.push({
            code: 'CRITICAL_ON_TENANT_ROLE',
            severity: 'high',
            title: 'Critical permission on a tenant-level role',
            description: `Tenant role "${role.name}" holds the critical permission "${rp.slug}".`,
            permissionId: rp.permId,
            permissionSlug: rp.slug,
            roleId: role.id,
            roleName: role.name,
            module: rp.module,
            remediation:
              'Review whether a tenant-scoped role should wield this critical permission; consider narrowing it.',
            autoFixable: false,
          });
        }

        if (rp.scope === 'platform' && isTenantScoped) {
          findings.push({
            code: 'ROLE_SCOPE_MISMATCH',
            severity: 'warning',
            title: 'Platform-scoped permission on a tenant role',
            description: `Tenant role "${role.name}" holds the platform-scoped permission "${rp.slug}".`,
            permissionId: rp.permId,
            permissionSlug: rp.slug,
            roleId: role.id,
            roleName: role.name,
            module: rp.module,
            remediation:
              'Platform-scoped permissions should live on platform/system roles. Reconsider this grant.',
            autoFixable: false,
          });
        }

        if (
          (rp.risk === 'high' || rp.risk === 'critical') &&
          role.userCount >= BROAD_ROLE_USER_THRESHOLD
        ) {
          findings.push({
            code: 'HIGH_RISK_BROAD_ASSIGNMENT',
            severity: 'warning',
            title: 'High-risk permission on a broadly-assigned role',
            description: `"${rp.slug}" (${rp.risk}) is held by role "${role.name}", which is assigned to ${role.userCount} users.`,
            permissionId: rp.permId,
            permissionSlug: rp.slug,
            roleId: role.id,
            roleName: role.name,
            module: rp.module,
            remediation:
              'Confirm every holder genuinely needs this high-risk permission; consider a narrower role for the few who do.',
            autoFixable: false,
          });
        }
      }

      // Dangerous combinations — only meaningful on non-system (custom) roles;
      // system roles (super_admin/owner) are designed to hold broad power.
      const slugSet = new Set(perms.map((p) => p.slug));
      for (const combo of DANGEROUS_COMBINATIONS) {
        if (!role.is_system && combo.slugs.every((s) => slugSet.has(s))) {
          findings.push({
            code: 'DANGEROUS_ROLE_COMBINATION',
            severity: 'high',
            title: 'Dangerous permission combination on a role',
            description: `Role "${role.name}" ${combo.reason}`,
            permissionId: null,
            permissionSlug: combo.slugs.join(' + '),
            roleId: role.id,
            roleName: role.name,
            module: null,
            remediation:
              'Split these capabilities across separate roles, or restrict this role to trusted platform operators.',
            autoFixable: false,
          });
        }
      }
    }

    return findings;
  }

  private static readonly SEVERITY_RANK: Record<AuditSeverity, number> = {
    critical: 4,
    high: 3,
    warning: 2,
    info: 1,
  };

  /** Filtered + severity-ranked findings for the audit feed. */
  async findings(query: QueryAuditDto): Promise<{
    data: RbacFinding[];
    total: number;
    countsBySeverity: Record<AuditSeverity, number>;
    countsByCode: Record<string, number>;
  }> {
    const all = await this.buildFindings();

    const countsBySeverity: Record<AuditSeverity, number> = {
      critical: 0,
      high: 0,
      warning: 0,
      info: 0,
    };
    const countsByCode: Record<string, number> = {};
    for (const f of all) {
      countsBySeverity[f.severity]++;
      countsByCode[f.code] = (countsByCode[f.code] ?? 0) + 1;
    }

    let data = all;
    if (query.severity) data = data.filter((f) => f.severity === query.severity);
    if (query.code) data = data.filter((f) => f.code === query.code);
    if (query.module) data = data.filter((f) => f.module === query.module);

    data = [...data].sort(
      (a, b) =>
        RbacAuditService.SEVERITY_RANK[b.severity] -
        RbacAuditService.SEVERITY_RANK[a.severity],
    );

    return { data, total: data.length, countsBySeverity, countsByCode };
  }

  /** Findings that reference a specific permission id (for the details drawer). */
  async findingsForPermission(permissionId: string): Promise<RbacFinding[]> {
    const all = await this.buildFindings();
    return all
      .filter((f) => f.permissionId === permissionId)
      .sort(
        (a, b) =>
          RbacAuditService.SEVERITY_RANK[b.severity] -
          RbacAuditService.SEVERITY_RANK[a.severity],
      );
  }
}
