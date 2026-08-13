import {
  Body,
  Controller,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { TenantService } from './tenant.service';
import { TenantVerificationService } from './tenant-verification.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ListTenantsQueryDto } from './dto/list-tenants.query.dto';
import { TenantApprovalActionDto } from './dto/tenant-approval-action.dto';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';

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

const S_APPROVAL_EVENT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['pending', 'approved', 'rejected', 'suspended'],
      example: 'approved',
    },
    reason: {
      type: 'string',
      nullable: true,
      example: 'All documents verified.',
    },
    actorId: { type: 'string', format: 'uuid', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const S_SETTINGS = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    bookingConfirmation: {
      type: 'string',
      enum: ['AUTO', 'MANUAL'],
      example: 'AUTO',
      description:
        'Whether bookings are auto-confirmed or require staff approval.',
    },
    paymentRequired: { type: 'boolean', example: false },
    cancellationHours: {
      type: 'number',
      example: 24,
      description:
        'Hours before appointment within which cancellation is blocked.',
    },
    feedbackDelayMinutes: {
      type: 'number',
      example: 360,
      description:
        'Minutes after appointment before the feedback request is sent.',
    },
    defaultLanguage: { type: 'string', example: 'ar' },
    currency: { type: 'string', example: 'SAR' },
    botEnabled: { type: 'boolean', example: true },
  },
};

const S_TENANT_DETAIL = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Al-Noor Clinic' },
    slug: {
      type: 'string',
      example: 'al-noor-clinic',
      description: 'Immutable URL-safe identifier used at login.',
    },
    legalName: {
      type: 'string',
      nullable: true,
      example: 'Al-Noor Medical Services LLC',
    },
    commercialRegistrationNumber: { type: 'string', example: '1010123456' },
    contactEmail: {
      type: 'string',
      format: 'email',
      example: 'admin@al-noor.com',
    },
    contactPhone: { type: 'string', nullable: true, example: '+966112345678' },
    logoUrl: { type: 'string', nullable: true },
    approvalStatus: {
      type: 'string',
      enum: ['pending', 'approved', 'rejected', 'suspended'],
      example: 'approved',
    },
    isActive: { type: 'boolean', example: true },
    countryId: { type: 'number', nullable: true, example: 194 },
    defaultCurrency: { type: 'string', nullable: true, example: 'SAR' },
    defaultTimezone: { type: 'string', nullable: true, example: 'Asia/Riyadh' },
    settings: S_SETTINGS,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const S_TENANT_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_TENANT_DETAIL },
    total: { type: 'number', example: 42 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two audiences, one resource:
 *  - PLATFORM admin (super_admin): list / create / inspect / approve / reject /
 *    suspend ANY tenant (the `/:id` routes).
 *  - TENANT self-service (owner/manager within their own tenant): the `/me`
 *    routes, always scoped to the principal's own tenantId.
 *
 * `/me*` routes are declared before `/:id` so they are matched literally.
 */
@ApiTags('Tenants')
@NoEntitlementRequired()
@Controller('tenants')
@UseGuards(RolesGuard)
@ApiBearerAuth('JWT-auth')
export class TenantController {
  constructor(
    private readonly tenantService: TenantService,
    private readonly ctx: TenantContextService,
    private readonly verification: TenantVerificationService,
  ) {}

  // ─────────────────────────── Platform admin ────────────────────────────── //

  @ApiOperation({
    summary: 'Create a tenant directly (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Directly provisions a new clinic tenant. Unlike the public
\`POST /auth/register-owner\` onboarding flow, this endpoint does
**not** create an owner user — it only creates the tenant record.

Useful for bulk provisioning or administrative setup of clinics that
are already known customers.

**Business rules:**
- The \`slug\` is globally unique and **immutable** after creation.
- The new tenant starts with \`approvalStatus = pending\`.
- Default \`TenantSettings\` are created automatically.

**Who can call this:** \`super_admin\` only.

**Tenant scoping:** None — creates a new top-level tenant.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Tenant created with pending approval status.',
    schema: S_TENANT_DETAIL,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Slug or commercial registration number already exists.',
    schema: S_ERROR,
  })
  @Post()
  @Roles(ROLE.SUPER_ADMIN)
  create(@Body() dto: CreateTenantDto, @CurrentUser('id') actorId: string) {
    return this.tenantService.create(dto, actorId);
  }

  @ApiOperation({
    summary: 'List all tenants with filters and pagination (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Returns a paginated list of all tenants across the platform. Use
\`status\` to filter by approval lifecycle state and \`search\` to
find a clinic by name or slug.

**Who can call this:** \`super_admin\` only.

**Tenant scoping:** Returns data for ALL tenants — no isolation filter
is applied.
    `.trim(),
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    description: 'Filter by approval lifecycle status.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Search by clinic name or slug (case-insensitive, partial match).',
    example: 'al-noor',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (default: 1).',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Results per page (default: 20, max: 100).',
    example: 20,
  })
  @ApiOkResponse({
    description: 'Paginated list of tenants.',
    schema: S_TENANT_LIST,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @Get()
  @Roles(ROLE.SUPER_ADMIN)
  findAll(@Query() query: ListTenantsQueryDto) {
    return this.tenantService.findAll(query);
  }

  // ─────────────────────────── Self-service ──────────────────────────────── //

  @ApiOperation({
    summary: "Get my clinic's profile (self-service)",
    description: `
**Protected — any authenticated tenant user.**

Returns the full profile of the caller's own clinic. The tenant is
resolved from the JWT principal — no tenant ID in the URL or body.

**Who can call this:** Any authenticated user with a non-null
\`tenantId\` (owner, manager, receptionist, customer).

**Tenant scoping:** Always returns the caller's own tenant.
Super-admins (tenantId = null) will receive a 403.
    `.trim(),
  })
  @ApiOkResponse({
    description: "Caller's clinic profile.",
    schema: S_TENANT_DETAIL,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller has no tenant context (super-admin accounts do not belong to a clinic).',
    schema: S_ERROR,
  })
  @Get('me')
  myTenant() {
    return this.tenantService.findById(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: "Update my clinic's profile (owner self-service)",
    description: `
**Protected — \`owner\` role required.**

Updates the mutable profile fields of the caller's own clinic.

**Immutable fields** (not available in this endpoint):
- \`slug\` — URL identifier, immutable after creation
- \`approvalStatus\` / \`isActive\` — changed only via the approval
  lifecycle endpoints (\`approve\`, \`reject\`, \`suspend\`)

**Who can call this:** Clinic Owner only.

**Tenant scoping:** Always operates on the caller's own tenant.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Clinic profile updated.',
    schema: S_TENANT_DETAIL,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not the clinic `owner`.',
    schema: S_ERROR,
  })
  @Patch('me')
  @Roles(ROLE.OWNER)
  updateMyTenant(@Body() dto: UpdateTenantDto) {
    return this.tenantService.updateProfile(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: "Get my clinic's operational settings (self-service)",
    description: `
**Protected — any authenticated tenant user.**

Returns the operational configuration of the caller's clinic:
booking confirmation mode, payment requirements, cancellation policy,
feedback delay, language, currency, and AI bot toggle.

**Who can call this:** Any authenticated tenant user.

**Tenant scoping:** Always returns settings for the caller's own clinic.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Clinic operational settings.',
    schema: S_SETTINGS,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller has no tenant context.',
    schema: S_ERROR,
  })
  @Get('me/settings')
  mySettings() {
    return this.tenantService.getSettings(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: "Update my clinic's operational settings",
    description: `
**Protected — \`owner\` or \`manager\` role required.**

Partially updates the operational settings of the caller's clinic.
Only the supplied fields are changed; omitted fields retain their
current values.

**Key settings:**
- \`bookingConfirmation\`: \`AUTO\` (instant confirmation) or \`MANUAL\`
  (staff must approve each booking).
- \`cancellationHours\`: How many hours before the appointment
  cancellation is blocked (0 = always allowed).
- \`botEnabled\`: Enables/disables the WhatsApp AI chatbot for this
  clinic.

**Who can call this:** Clinic Owner or Manager.

**Tenant scoping:** Always operates on the caller's own clinic.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Settings updated.', schema: S_SETTINGS })
  @ApiBadRequestResponse({
    description: 'Validation failed (e.g. cancellationHours > 720).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `owner` or `manager`.',
    schema: S_ERROR,
  })
  @Patch('me/settings')
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  updateMySettings(@Body() dto: UpdateTenantSettingsDto) {
    return this.tenantService.updateSettings(this.ctx.requireTenantId(), dto);
  }

  // ────────────────────── Platform admin (by ID) ─────────────────────────── //

  @ApiOperation({
    summary: 'Get any tenant by ID (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Returns the full profile of any tenant by its UUID, including all
approval events and settings.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Tenant UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Tenant found.', schema: S_TENANT_DETAIL })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Tenant not found.', schema: S_ERROR })
  @Get(':id')
  @Roles(ROLE.SUPER_ADMIN)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantService.findById(id);
  }

  @ApiOperation({
    summary: "Update any tenant's profile (platform admin)",
    description: `
**Protected — \`super_admin\` role required.**

Allows platform admins to update any clinic's profile details.
The \`slug\` field is excluded (immutable). Approval status changes
must use the dedicated \`approve\`/\`reject\`/\`suspend\` actions.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Tenant UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Tenant profile updated.',
    schema: S_TENANT_DETAIL,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Tenant not found.', schema: S_ERROR })
  @Patch(':id')
  @Roles(ROLE.SUPER_ADMIN)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto) {
    return this.tenantService.updateProfile(id, dto);
  }

  @ApiOperation({
    summary: 'Approve a clinic (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Transitions the tenant's \`approvalStatus\` from \`pending\` (or \`rejected\`,
or \`suspended\`) to \`approved\` and sets \`isActive = true\`.

**Effect:** Once approved, the clinic's staff can access all
tenant-protected routes (the \`ActiveTenantGuard\` will pass for this
tenant).

**Side effects:**
- An \`approved\` entry is appended to the tenant's approval event log.
- A notification may be triggered to the clinic owner (via the
  notification module).

The optional \`reason\` is recorded in the audit trail.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Tenant UUID to approve',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Tenant approved and activated.',
    schema: S_TENANT_DETAIL,
  })
  @ApiBadRequestResponse({
    description: 'State transition is invalid (e.g. already approved).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Tenant not found.', schema: S_ERROR })
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(ROLE.SUPER_ADMIN)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantApprovalActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    // Source-of-truth gate: a clinic cannot be approved unless every required
    // verification document has been supplied.
    await this.verification.assertReadyForApproval(id);
    return this.tenantService.approve(id, actorId, dto.reason);
  }

  @ApiOperation({
    summary: 'Reject a clinic application (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Transitions the tenant's status to \`rejected\` and sets
\`isActive = false\`.

**Effect:** The clinic's staff will receive \`403 Tenant is not active\`
on all tenant-protected routes.

The optional \`reason\` is recorded in the approval event log and
surfaced to the clinic owner via the rejection notification.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Tenant UUID to reject',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Tenant rejected.', schema: S_TENANT_DETAIL })
  @ApiBadRequestResponse({
    description: 'Invalid state transition.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Tenant not found.', schema: S_ERROR })
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(ROLE.SUPER_ADMIN)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantApprovalActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.tenantService.reject(id, actorId, dto.reason);
  }

  @ApiOperation({
    summary: 'Suspend a clinic (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Suspends an active clinic by setting \`approvalStatus = suspended\`
and \`isActive = false\`.

**Effect:** All clinic staff immediately receive
\`403 Tenant is not active (status: suspended)\` on protected routes.
Existing sessions are not revoked — the block is enforced at the
\`ActiveTenantGuard\` layer on every request.

Common reasons: non-payment, policy violation, or fraud investigation.

The clinic owner can re-apply by submitting updated verification
documents. Re-approval transitions back to \`approved\`.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Tenant UUID to suspend',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Tenant suspended.', schema: S_TENANT_DETAIL })
  @ApiBadRequestResponse({
    description: 'Invalid state transition.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Tenant not found.', schema: S_ERROR })
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @Roles(ROLE.SUPER_ADMIN)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantApprovalActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.tenantService.suspend(id, actorId, dto.reason);
  }

  @ApiOperation({
    summary: 'Get approval history for a tenant (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Returns the chronological approval event log for a tenant. Each entry
records a status transition: who made it (\`actorId\`), when, and the
optional reason.

Events include: initial \`pending\` creation, \`approved\`, \`rejected\`,
\`suspended\`, and any subsequent re-approval cycles.

Useful for auditing a clinic's compliance history.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Tenant UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Chronological approval event log.',
    schema: { type: 'array', items: S_APPROVAL_EVENT },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Tenant not found.', schema: S_ERROR })
  @Get(':id/approval-events')
  @Roles(ROLE.SUPER_ADMIN)
  approvalEvents(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantService.getApprovalEvents(id);
  }
}
