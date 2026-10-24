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
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CustomerService } from './customer.service';
import { CustomerAiRepliesService } from './customer-ai-replies.service';
import { UpdateCustomerAiRepliesDto } from './dto/update-customer-ai-replies.dto';
import { ClinicalAccessLogService } from '../medical-records/clinical-access-log.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { SearchCustomersDto } from './dto/search-customers.dto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { RequireAnyPermission } from '../auth/decorators/require-any-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AppError, ErrorCode } from '../../common/errors';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

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

/**
 * Customers. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id always
 * from TenantContext (never request input).
 */
@ApiTags('CRM Customers')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CRM)
@Controller('crm/customers')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerController {
  constructor(
    private readonly customers: CustomerService,
    private readonly ctx: TenantContextService,
    // Residency plan P14 — reads of D4 data are accounted for (who, which patient, when).
    private readonly accessLog: ClinicalAccessLogService,
    private readonly aiReplies: CustomerAiRepliesService,
  ) {}

  @ApiOperation({
    summary: 'Create a customer',
    description:
      '**Protected — `crm.customers.manage`. Clinic active.** Email and ID number (when provided) are each unique per tenant among live customers (409 on conflict); phone may be shared across customers.',
  })
  @ApiCreatedResponse({ description: 'Customer created.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Duplicate email or ID number.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  create(@Body() dto: CreateCustomerDto, @CurrentUser('id') userId: string) {
    return this.customers.create(this.ctx.requireTenantId(), dto, {
      actorUserId: userId,
    });
  }

  @ApiOperation({
    summary: 'List customers',
    description:
      '**Protected — `crm.customers.read`. Clinic active.** Tenant-scoped, newest first, optional active filter + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated customers.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  list(@Query() query: QueryCustomersDto) {
    return this.customers.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Search customers',
    description:
      '**Protected — `crm.customers.read`. Clinic active.** Partial match on name/email/phone/national ID + optional tag filter, tenant-scoped.',
  })
  @ApiOkResponse({ description: 'Paginated search results.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('search')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  search(@Query() query: SearchCustomersDto) {
    return this.customers.search(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get customer details',
    description:
      "**Protected — `crm.customers.read`. Clinic active.** Includes profile, addresses and assigned tags. Another tenant's customer returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description:
      "Customer details. T108 (spec 014, US6, FR-H010d) — the profile's clinical fields " +
      '(medical_history, allergies, blood_type, notes) are included only when the caller ' +
      'additionally holds `clinical.records.read`; contact, addresses, tags and the intake ' +
      'chronic-condition fields are unaffected.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  async getDetails(@Param('id', ParseUUIDPipe) id: string) {
    const user = this.ctx.getUser();
    // Mirrors PermissionsGuard's own super_admin bypass (role-based, not a
    // literal '*' in `permissions`) — a super_admin who reaches this
    // tenant-scoped route did so via that same role bypass.
    const hasClinicalAccess =
      Boolean(user?.roles.includes(ROLE.SUPER_ADMIN)) ||
      Boolean(user?.permissions.includes(PERMISSION.CLINICAL_RECORDS_READ));
    const tenantId = this.ctx.requireTenantId();
    const details = await this.customers.getDetails(
      tenantId,
      id,
      hasClinicalAccess,
    );
    // Residency plan P14: the detail view carries health intake (chronic disease,
    // insurance) ONLY for a caller with clinical access — that is the read to account for.
    if (hasClinicalAccess && user?.id) {
      await this.accessLog.record(tenantId, id, user.id, 'profile');
    }
    return details;
  }

  @ApiOperation({
    summary: 'Update a customer',
    description:
      '**Protected — `crm.customers.manage` OR `crm.customers.update_own`. Clinic active.** Partial update; ID number uniqueness re-checked when changed. ' +
      'A `crm.customers.update_own` holder (doctor) without `manage` may edit only a patient they have an appointment with (403 otherwise) and only contact/demographic fields ' +
      '(full_name, phone, email, gender, date_of_birth, preferred_locale, has_chronic_diseases, chronic_diseases) — any other field is refused with 403, never silently dropped.',
  })
  @ApiParam({
    name: 'id',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Customer updated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `crm.customers.manage` and `crm.customers.update_own`, or clinic inactive, or (update_own only) the patient is not theirs / a field outside their allow-list was supplied.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Duplicate email or ID number.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequireAnyPermission(
    PERMISSION.CRM_CUSTOMERS_MANAGE,
    PERMISSION.CRM_CUSTOMERS_UPDATE_OWN,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const user = this.ctx.getUser();
    if (!user) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'An authenticated user is required for this operation',
      });
    }
    // Mirrors PermissionsGuard's own super_admin bypass (role-based, not a
    // literal '*' in `permissions`). A `manage` holder keeps the unchanged,
    // clinic-wide edit; anyone admitted only by `update_own` is confined to
    // their own patients and the provider field allow-list.
    const canManage =
      user.roles.includes(ROLE.SUPER_ADMIN) ||
      user.permissions.includes(PERMISSION.CRM_CUSTOMERS_MANAGE);
    return canManage
      ? this.customers.update(tenantId, id, dto, { actorUserId: user.id })
      : this.customers.updateOwnPatient(tenantId, user.id, id, dto);
  }

  @ApiOperation({
    summary: 'Exclude a patient from, or return them to, the WhatsApp AI',
    description:
      '**Protected — `crm.customers.manage`. Clinic active.** `disabled: true` stops the WhatsApp AI answering this patient on every conversation and number; their messages are still received and shown to staff. Idempotent. Audited. A dedicated route: the generic customer update cannot change it, so a role limited to `crm.customers.update_own` cannot flip it.',
  })
  @ApiParam({
    name: 'id',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: "The patient's AI-replies state.",
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        aiRepliesDisabled: { type: 'boolean' },
        aiRepliesDisabledAt: {
          type: 'string',
          format: 'date-time',
          nullable: true,
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Patch(':id/ai-replies')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  setAiReplies(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerAiRepliesDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiReplies.setDisabled(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto.disabled,
    );
  }

  @ApiOperation({
    summary: 'Delete a customer (soft)',
    description:
      '**Protected — `crm.customers.manage`. Clinic active.** Soft-deletes the customer (`deleted_at`).',
  })
  @ApiParam({
    name: 'id',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Customer soft-deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(this.ctx.requireTenantId(), id);
  }
}
