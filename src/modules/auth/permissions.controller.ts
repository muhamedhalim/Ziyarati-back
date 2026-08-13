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
  Query,
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
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { PermissionsService } from './permissions.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

import { Roles } from './decorators/roles.decorator';
import { RequirePermissions } from './decorators/permissions.decorator';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';

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

const S_PERMISSION_DETAIL = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      format: 'uuid',
      example: 'b2c3d4e5-0000-0000-0000-000000000020',
    },
    name: { type: 'string', example: 'Create Appointments' },
    slug: { type: 'string', example: 'appointments.create' },
    module: {
      type: 'string',
      example: 'appointments',
      nullable: true,
      description: 'Logical grouping for display and filtering purposes.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The permission catalogue is global. Reading it is available to anyone allowed
 * to manage roles (so they can attach permissions); mutating it is restricted
 * to platform super-admins via the `super_admin` system role.
 */
@ApiTags('Permissions')
@Controller('permissions')
@ApiBearerAuth('JWT-auth')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @ApiOperation({
    summary: 'Create a new permission (platform only)',
    description: `
**Protected — \`super_admin\` role required.**

Adds a new permission to the global permission catalogue.

In production, the permission catalogue is managed exclusively by the
seeder (\`src/seed/seeders/rbac.seeder.ts\`). This endpoint exists for
operational use by the platform team when rolling out new features.

**After adding a permission:**
1. Add the slug constant to \`rbac.constants.ts\`.
2. Use \`PUT /roles/:id/permissions\` to assign it to the appropriate roles.
3. Reference it in application guards via \`@RequirePermissions(PERMISSION.XYZ)\`.

**Who can call this:** \`super_admin\` only (platform-level role).

**Tenant scoping:** None — permissions are global and shared by all
tenants.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Permission created.',
    schema: S_PERMISSION_DETAIL,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed or slug does not match the required pattern `[a-z0-9:._-]+` (use dot-notation e.g. `appointments.create`).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller does not have the `super_admin` role.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'A permission with this slug already exists.',
    schema: S_ERROR,
  })
  @Post()
  @UseGuards(RolesGuard)
  @Roles(ROLE.SUPER_ADMIN)
  create(@Body() dto: CreatePermissionDto) {
    return this.permissionsService.create(dto);
  }

  @ApiOperation({
    summary: 'List all permissions (optionally filtered by module)',
    description: `
**Protected — requires \`roles.manage\` permission.**

Returns the entire global permission catalogue. Use the optional
\`module\` query parameter to filter by domain group (e.g. all
appointment-related permissions).

This endpoint is primarily used by the role-management UI to let
administrators discover and attach permissions to custom roles via
\`PUT /roles/:id/permissions\`.

**Available module groups (as seeded):**
\`appointments\`, \`reports\`, \`users\`, \`roles\`, \`tenants\`, \`billing\`,
\`patients\`, \`profile\`

**Who can call this:** Users with \`roles.manage\` permission — typically
clinic owners and managers who configure RBAC for their staff.

**Tenant scoping:** None — the permission catalogue is platform-wide.
    `.trim(),
  })
  @ApiQuery({
    name: 'module',
    required: false,
    description:
      'Filter by module group (e.g. `appointments`, `reports`, `users`).',
    example: 'appointments',
  })
  @ApiOkResponse({
    description: 'Permission catalogue, optionally filtered by module.',
    schema: { type: 'array', items: S_PERMISSION_DETAIL },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `roles.manage` permission.',
    schema: S_ERROR,
  })
  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findAll(@Query('module') module?: string) {
    return this.permissionsService.findAll(module);
  }

  @ApiOperation({
    summary: 'Get a single permission by ID',
    description: `
**Protected — requires \`roles.manage\` permission.**

Returns the full record for a single permission by its UUID.

Useful for resolving a permission UUID back to its slug and name
after fetching it from a role's permission list.

**Who can call this:** Users with \`roles.manage\` permission.

**Tenant scoping:** None — permissions are global.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'UUID of the permission',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Permission found.',
    schema: S_PERMISSION_DETAIL,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `roles.manage` permission.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Permission not found.',
    schema: S_ERROR,
  })
  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.permissionsService.findOne(id);
  }

  @ApiOperation({
    summary: "Update a permission's name or module (platform only)",
    description: `
**Protected — \`super_admin\` role required.**

Updates the human-readable \`name\` or \`module\` grouping of an existing
permission. Both fields are cosmetic — they affect only the Swagger UI
and admin dashboards.

The \`slug\` is **immutable** — it is the identifier referenced by
application guards (\`@RequirePermissions\`). Changing a slug would
silently break all guards that reference it and requires a coordinated
code deploy + migration.

**Who can call this:** \`super_admin\` only.

**Tenant scoping:** None.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'UUID of the permission to update',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Permission updated.',
    schema: S_PERMISSION_DETAIL,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller does not have the `super_admin` role.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Permission not found.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(ROLE.SUPER_ADMIN)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePermissionDto,
  ) {
    return this.permissionsService.update(id, dto);
  }

  @ApiOperation({
    summary: 'Delete a permission (platform only)',
    description: `
**Protected — \`super_admin\` role required.**

⚠️ **Irreversible and potentially breaking.** Removes a permission from
the global catalogue.

**Consequences of deleting a permission:**
- Any \`@RequirePermissions(PERMISSION.XYZ)\` guard that references the
  deleted slug will silently **deny all requests** (the permission will
  never be found on any user).
- All role-permission assignment rows that reference this permission are
  removed via cascade.

Only delete permissions when the corresponding feature has been fully
removed from the codebase **and** the slug constant has been removed
from \`rbac.constants.ts\`.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'UUID of the permission to delete',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Permission deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller does not have the `super_admin` role.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Permission not found.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles(ROLE.SUPER_ADMIN)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.permissionsService.remove(id);
  }
}
