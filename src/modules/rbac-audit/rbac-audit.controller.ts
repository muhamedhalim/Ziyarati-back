import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { PermissionsAuditService } from './permissions-audit.service';
import { RbacAuditService } from './rbac-audit.service';
import { QueryPermissionsDto } from './dto/query-permissions.dto';
import { QueryAuditDto } from './dto/query-audit.dto';
import { CompareRolesDto } from './dto/compare-roles.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Permissions & Access-Control Audit Center — Platform Super-Admin only.
 *
 * READ-ONLY reporting/auditing over the existing RBAC model. It never mutates
 * roles, permissions or grants: permission slugs remain code-level contracts
 * owned by the registry + seeder. Every route is guarded by `RolesGuard` +
 * `@Roles(super_admin)`; tenant users are rejected with 403 exactly like the
 * rest of the platform admin surface. Only aggregate user COUNTS are returned —
 * never user PII.
 */
@ApiTags('RBAC Audit (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/rbac')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({
  description: 'Caller does not have the super_admin role.',
})
export class RbacAuditController {
  constructor(
    private readonly perms: PermissionsAuditService,
    private readonly audit: RbacAuditService,
  ) {}

  @ApiOperation({
    summary: 'Permission catalogue KPI statistics',
    description:
      'Backend-calculated audit KPIs: totals, modules, assigned/unassigned, high-risk (high+critical), critical, deprecated and missing-description counts.',
  })
  @ApiOkResponse({ description: 'KPI counters for the audit cards.' })
  @Get('permissions/stats')
  stats() {
    return this.perms.stats();
  }

  @ApiOperation({
    summary: 'List permissions (server-side filter / sort / pagination)',
    description:
      'Each row includes assigned-role count and DISTINCT effective-user count. Sortable columns are whitelisted; search/filters are parameterised.',
  })
  @ApiOkResponse({
    description: 'Paginated permission rows: `{ data, total, page, limit }`.',
  })
  @Get('permissions')
  list(@Query() query: QueryPermissionsDto) {
    return this.perms.list(query);
  }

  @ApiOperation({
    summary: 'Permission details (metadata, assigned roles, related, warnings)',
    description:
      'Full metadata plus assigned roles (with aggregate user counts only — no PII), related permissions in the same module, and RBAC audit warnings for this permission.',
  })
  @ApiParam({
    name: 'id',
    description: 'UUID of the permission',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Permission details payload.' })
  @Get('permissions/:id')
  details(@Param('id', ParseUUIDPipe) id: string) {
    return this.perms.details(id);
  }

  @ApiOperation({
    summary: 'Module summaries',
    description:
      'Per-module counts derived from backend data (never hard-coded): total / assigned / unassigned / high-risk permissions.',
  })
  @ApiOkResponse({ description: 'Array of module summaries.' })
  @Get('modules')
  modules() {
    return this.perms.modules();
  }

  @ApiOperation({
    summary: 'Roles list (for the comparison selectors)',
    description:
      'Roles with permission and DISTINCT user counts. Used to populate the role-comparison pickers.',
  })
  @ApiOkResponse({ description: 'Array of role summaries.' })
  @Get('roles')
  roles() {
    return this.perms.listRoles();
  }

  @ApiOperation({
    summary: 'Compare two roles by their permissions',
    description:
      'Computed from role→permission relations (by id, never role names). Returns shared / only-A / only-B permission sets with module, risk, scope and deprecated status. Rejects comparing a role with itself.',
  })
  @ApiOkResponse({ description: 'Role comparison matrix.' })
  @Get('compare')
  compare(@Query() query: CompareRolesDto) {
    return this.perms.compareRoles(query);
  }

  @ApiOperation({
    summary: 'RBAC audit findings',
    description:
      'Read-only findings across the RBAC graph (unassigned, missing description, deprecated-assigned, scope mismatch, critical-on-tenant-role, dangerous combinations, registry/DB drift). Filterable by severity, code and module.',
  })
  @ApiOkResponse({ description: 'Findings + counts by severity and code.' })
  @Get('audit')
  auditFindings(@Query() query: QueryAuditDto) {
    return this.audit.findings(query);
  }
}
