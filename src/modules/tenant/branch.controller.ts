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

import { BranchService } from './branch.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

// ─── Reusable inline response schema fragments ────────────────────────────────

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const S_BRANCH_DETAIL = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Riyadh - Olaya Branch' },
    address: { type: 'string', nullable: true, example: 'King Fahad Rd, Olaya, Riyadh 12211' },
    cityId: { type: 'string', format: 'uuid', nullable: true },
    phone: { type: 'string', nullable: true, example: '+966112345678' },
    whatsappPhone: {
      type: 'string',
      nullable: true,
      example: '+966501234567',
      description: 'Branch-specific WhatsApp number. Each branch can run its own WhatsApp AI chatbot.',
    },
    timezone: { type: 'string', nullable: true, example: 'Asia/Riyadh' },
    isActive: { type: 'boolean', example: true },
    tenantId: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Branch management — a tenant BUSINESS resource.
 *
 *  - ActiveTenantGuard ensures the tenant is APPROVED + active (else 403).
 *  - The tenantId comes from TenantContextService (single source of truth);
 *    no `requireTenant(...)` duplication, no tenantId in the URL/body.
 */
@ApiTags('Branches')
@Controller('branches')
@UseGuards(RolesGuard, ActiveTenantGuard)
@ApiBearerAuth('JWT-auth')
export class BranchController {
  constructor(
    private readonly branchService: BranchService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a new clinic branch',
    description: `
**Protected — \`owner\` or \`manager\` role required. Tenant must be active.**

Creates a new physical branch (location) for the caller's clinic.
Each branch can have its own phone number, WhatsApp number, city, and
timezone — supporting clinics with multiple independent locations.

**Branch-level WhatsApp:** If \`whatsappPhone\` is set, this branch
runs its own AI chatbot instance for appointment bookings. Without it,
the branch inherits the clinic-level configuration.

**Who can call this:** Clinic Owner or Manager.

**Tenant scoping:** Branch is always created under the caller's tenant.
The tenantId comes from the JWT — never from the request body.

**Guard behaviour:** \`ActiveTenantGuard\` rejects the request with
\`403 Tenant is not active\` if the tenant's approval status is not
\`approved\` or \`isActive\` is false.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Branch created.', schema: S_BRANCH_DETAIL })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description:
      'Caller is not `owner` or `manager`, OR the clinic is not approved/active (ActiveTenantGuard).',
    schema: S_ERROR,
  })
  @Post()
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  create(@Body() dto: CreateBranchDto) {
    return this.branchService.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List all branches of the caller\'s clinic',
    description: `
**Protected — any authenticated tenant user. Tenant must be active.**

Returns all branches belonging to the caller's clinic, including their
contact information, timezone, and activation status.

Useful for displaying a branch picker in the booking UI and for
navigating between branch-level management screens.

**Who can call this:** Any authenticated user in an active clinic
(owner, manager, receptionist, customer).

**Tenant scoping:** Returns only branches of the caller's own clinic.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'All branches for the caller\'s clinic.',
    schema: { type: 'array', items: S_BRANCH_DETAIL },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller has no tenant context, or the clinic is not active.',
    schema: S_ERROR,
  })
  @Get()
  findAll() {
    return this.branchService.findAll(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Get a single branch by ID',
    description: `
**Protected — any authenticated tenant user. Tenant must be active.**

Returns the full detail of a specific branch. The branch must belong
to the caller's clinic — branches from other clinics return 404
(tenant isolation).

**Who can call this:** Any authenticated user in an active clinic.

**Tenant scoping:** Validates that the branch belongs to the caller's
tenant before returning data.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Branch UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch found.', schema: S_BRANCH_DETAIL })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Clinic is not active.', schema: S_ERROR })
  @ApiNotFoundResponse({
    description: 'Branch not found or does not belong to this clinic.',
    schema: S_ERROR,
  })
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.branchService.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a branch',
    description: `
**Protected — \`owner\` or \`manager\` role required. Tenant must be active.**

Partially updates a branch's details. Only the supplied fields are
changed. To deactivate a branch without deleting it, set
\`isActive: false\`.

**Common use cases:**
- Updating the branch phone/WhatsApp number when it changes.
- Correcting the address after a relocation.
- Toggling \`isActive\` to temporarily hide a branch from bookings.

**Who can call this:** Clinic Owner or Manager.

**Tenant scoping:** Only branches belonging to the caller's clinic
can be updated.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Branch UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch updated.', schema: S_BRANCH_DETAIL })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller is not `owner` or `manager`, or the clinic is not active.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Branch not found.', schema: S_ERROR })
  @Patch(':id')
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchService.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Delete a branch (owner only)',
    description: `
**Protected — \`owner\` role required. Tenant must be active.**

Soft-deletes a branch — rejected with 409 unless deletion is safe:
- it is not the clinic's only branch (at least one must always remain),
- no staff are currently assigned to it (reassign them first), and
- it has no upcoming, non-cancelled appointments (cancel/reschedule them first).

For a softer option that preserves history, consider setting
\`isActive: false\` via \`PATCH /branches/:id\` instead.

**Who can call this:** Clinic Owner only.

**Tenant scoping:** Only branches belonging to the caller's clinic
can be deleted.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Branch UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Branch deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller is not `owner`, or the clinic is not active.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Branch not found.', schema: S_ERROR })
  @ApiConflictResponse({
    description:
      'Deletion is unsafe: it is the only branch, has assigned staff, or has upcoming appointments.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(ROLE.OWNER)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.branchService.remove(this.ctx.requireTenantId(), id);
  }
}
