import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { SetRolePermissionsDto } from './dto/set-role-permissions.dto';

import { CurrentUser } from './decorators/current-user.decorator';
import { RequirePermissions } from './decorators/permissions.decorator';
import { PermissionsGuard } from './guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';

// ─── Reusable inline response schema fragments ────────────────────────────────

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number', example: 403 },
    errorCode: { type: 'string', example: 'PERMISSION_DENIED' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const S_PERMISSION_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string', example: 'appointments.create' },
    name: { type: 'string', example: 'Create Appointments' },
    module: { type: 'string', example: 'appointments', nullable: true },
  },
};

const S_ROLE_DETAIL = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', example: 'a1b2c3d4-0000-0000-0000-000000000010' },
    name: { type: 'string', example: 'Senior Receptionist' },
    slug: { type: 'string', example: 'senior-receptionist' },
    description: { type: 'string', nullable: true, example: 'Handles VIP bookings' },
    tenantId: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description: 'null for system-level roles shared across all tenants',
    },
    permissions: { type: 'array', items: S_PERMISSION_ITEM },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const S_USER_ROLE_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    role: S_ROLE_DETAIL,
    assignedAt: { type: 'string', format: 'date-time' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role administration. Everything is scoped to the caller's tenant; the tenant
 * id is taken from the authenticated principal, never from the request body,
 * to keep tenants isolated.
 */
@ApiTags('Roles & RBAC')
@Controller('roles')
@ApiBearerAuth('JWT-auth')
@UseGuards(PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  // ────────────────────────── CRUD ───────────────────────────────────────── //

  @ApiOperation({
    summary: 'Create a custom role',
    description: `
**Protected — requires \`roles.manage\` permission.**

Creates a new role scoped to the caller's clinic. System-level roles
(\`super_admin\`, \`owner\`, \`manager\`, \`receptionist\`) are seeded globally and
cannot be duplicated via this endpoint — they are visible to all tenants.

After creation, attach permissions with
\`PUT /roles/:id/permissions\` and assign users with
\`POST /roles/:id/users/:userId\`.

**Business rules:**
- The \`slug\` must be lowercase alphanumeric with dashes.
- The \`slug\` is **immutable** after creation — it is referenced by application
  code and guards. Renaming requires a code deploy + migration.
- \`slug\` uniqueness is enforced within the tenant scope.

**Who can call this:** Clinic Owner or Manager with \`roles.manage\`
permission.

**Tenant scoping:** The role is always created under the caller's tenant.
Super-admins (\`tenantId = null\`) create global system roles.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Custom role created.', schema: S_ROLE_DETAIL })
  @ApiBadRequestResponse({
    description: 'Validation failed or slug does not match the required pattern `[a-z0-9-]+`.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller lacks the `roles.manage` permission.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'A role with this slug already exists within the tenant scope.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  create(
    @Body() dto: CreateRoleDto,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.create(dto, tenantId);
  }

  @ApiOperation({
    summary: 'List all roles visible to the caller',
    description: `
**Protected — requires \`roles.manage\` permission.**

Returns all roles accessible to the current principal:

- **Tenant users (owner / manager):** Returns the tenant's custom roles
  plus the global system roles applicable to that tenant
  (\`manager\`, \`receptionist\`).
- **Super-admin:** Returns all global system roles (\`tenantId = null\`).

Use this list to populate role-selection dropdowns in the admin UI and
to discover role IDs for the assignment endpoints.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** Results are automatically filtered to the caller's
tenant — no cross-tenant data is exposed.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Roles visible to the caller.',
    schema: { type: 'array', items: S_ROLE_DETAIL },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `roles.manage` permission.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findAll(@CurrentUser('tenantId') tenantId: string | null) {
    return this.rolesService.findAll(tenantId);
  }

  @ApiOperation({
    summary: 'Get a single role by ID',
    description: `
**Protected — requires \`roles.manage\` permission.**

Returns the full role record including its complete permission set.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** The role must belong to the caller's tenant or be a
global system role. Roles from other tenants return 404.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'UUID of the role to fetch', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Role found.', schema: S_ROLE_DETAIL })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `roles.manage` permission.', schema: S_ERROR })
  @ApiNotFoundResponse({
    description: 'Role not found or does not belong to this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.findOne(id, tenantId);
  }

  @ApiOperation({
    summary: 'Update a custom role',
    description: `
**Protected — requires \`roles.manage\` permission.**

Updates the mutable fields of a custom role (\`name\`, \`description\`,
\`permissionSlugs\`). The \`slug\` is **immutable** after creation.

System roles (\`super_admin\`, \`owner\`, \`manager\`, \`receptionist\`)
cannot be modified via this endpoint — they are managed by the seeder.

To fully replace a role's permission set, use the dedicated
\`PUT /roles/:id/permissions\` endpoint instead.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** Only roles belonging to the caller's tenant are
mutable.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'UUID of the role to update', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Role updated.', schema: S_ROLE_DETAIL })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `roles.manage` permission, or attempted to modify a system role.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Role not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.update(id, dto, tenantId);
  }

  @ApiOperation({
    summary: 'Delete a custom role',
    description: `
**Protected — requires \`roles.manage\` permission.**

Permanently deletes a custom role. The role must have **no active user
assignments** before it can be removed — unassign all users first via
\`DELETE /roles/:id/users/:userId\`.

System roles cannot be deleted.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** Only roles belonging to the caller's tenant can be
deleted.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'UUID of the role to delete', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Role deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `roles.manage` permission, tried to delete a system role, or the role still has active user assignments.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Role not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.remove(id, tenantId);
  }

  // ─────────────────────── Permission assignment ─────────────────────────── //

  @ApiOperation({
    summary: 'Replace a role\'s full permission set',
    description: `
**Protected — requires \`roles.manage\` permission.**

**Idempotent set replacement.** The provided \`permissionIds\` array
completely replaces the role's current permissions in a single atomic
operation. Passing an empty array removes all permissions from the role.

This is the authoritative way to manage a role's capabilities. Individual
add/remove operations are not supported — always send the full desired set.

**Finding permission IDs:** Call \`GET /permissions\` (optionally with
\`?module=appointments\`) to discover available permissions and their UUIDs.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** Operates only on roles in the caller's tenant.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'UUID of the role to configure', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Permissions replaced. Returns the updated role with its new permission set.',
    schema: S_ROLE_DETAIL,
  })
  @ApiBadRequestResponse({
    description: 'Validation failed — one or more values in `permissionIds` is not a valid UUID v4.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `roles.manage` permission.', schema: S_ERROR })
  @ApiNotFoundResponse({
    description: 'Role not found, or one or more of the permission UUIDs does not exist.',
    schema: S_ERROR,
  })
  @Put(':id/permissions')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolePermissionsDto,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.setPermissions(id, dto.permissionIds, tenantId);
  }

  // ──────────────────────── User assignment ──────────────────────────────── //

  @ApiOperation({
    summary: 'Assign a role to a user',
    description: `
**Protected — requires \`roles.manage\` permission.**

Grants the specified role to a user within the caller's tenant.

**Escalation prevention (two layers):**
1. The \`super_admin\` and \`owner\` roles are blocked at this endpoint —
   they cannot be assigned via the API regardless of the caller's
   own privileges.
2. The \`owner\` role is assigned only during clinic onboarding
   (\`POST /auth/register-owner\`).

A user can hold multiple roles simultaneously. Assigning a role
the user already holds is a no-op.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** Both the role and the target user must belong to the
caller's tenant. Cross-tenant assignment is rejected.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'UUID of the role to assign', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'userId', description: 'UUID of the target user', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Role assigned to user.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `roles.manage` permission, or attempted to assign `super_admin` / `owner` role.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Role or user not found, or they belong to different tenants.',
    schema: S_ERROR,
  })
  @Post(':id/users/:userId')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  assign(
    @Param('id', ParseUUIDPipe) roleId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.assignRoleToUser(userId, roleId, tenantId);
  }

  @ApiOperation({
    summary: 'Remove a role from a user',
    description: `
**Protected — requires \`roles.manage\` permission.**

Revokes the specified role from a user. The user retains any other roles
they hold. If this was their only role, they will have no permissions
until a new role is assigned.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** Both the role and the user must belong to the
caller's tenant.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'UUID of the role to remove', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'userId', description: 'UUID of the target user', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Role removed from the user.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `roles.manage` permission.', schema: S_ERROR })
  @ApiNotFoundResponse({
    description: 'Role, user, or the role-assignment record was not found.',
    schema: S_ERROR,
  })
  @Delete(':id/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  unassign(
    @Param('id', ParseUUIDPipe) roleId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.removeRoleFromUser(userId, roleId, tenantId);
  }

  @ApiOperation({
    summary: 'List all roles assigned to a user',
    description: `
**Protected — requires \`roles.manage\` permission.**

Returns every role-assignment record for the specified user, including
the full role detail and its permission set.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** The target user must belong to the caller's tenant.
    `.trim(),
  })
  @ApiParam({ name: 'userId', description: 'UUID of the user', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'All roles currently assigned to the user.',
    schema: { type: 'array', items: S_USER_ROLE_ITEM },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `roles.manage` permission.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'User not found in this tenant.', schema: S_ERROR })
  @Get('users/:userId')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  userRoles(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.listUserRoles(userId, tenantId);
  }
}
