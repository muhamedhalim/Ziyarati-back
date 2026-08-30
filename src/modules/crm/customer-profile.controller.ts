import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CustomerProfileService } from './customer-profile.service';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
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
 * Customer 1:1 profile. Guarded by PermissionsGuard + ActiveTenantGuard; tenant
 * id from TenantContext. Profile reads/writes use the customer permissions.
 */
@ApiTags('CRM Customer Profile')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CRM)
@Controller('crm/customers/:customerId/profile')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerProfileController {
  constructor(
    private readonly profiles: CustomerProfileService,
    private readonly ctx: TenantContextService,
  ) {}

  /** Mirrors PermissionsGuard's own super_admin role bypass (not a literal '*' in `permissions`). */
  private hasClinical(permission: string): boolean {
    const user = this.ctx.getUser();
    return (
      Boolean(user?.roles.includes(ROLE.SUPER_ADMIN)) ||
      Boolean(user?.permissions.includes(permission))
    );
  }

  @ApiOperation({
    summary: 'Get customer profile',
    description:
      '**Protected — `crm.customers.read`. Clinic active.** 404 if not set yet. ' +
      'T108 (spec 014, US6, FR-H010a/d) — the 4 clinical fields (medical_history, ' +
      'allergies, blood_type, notes) are included only with `clinical.records.read`.',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Customer profile.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer or profile not found.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  get(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.profiles.get(
      this.ctx.requireTenantId(),
      customerId,
      this.hasClinical(PERMISSION.CLINICAL_RECORDS_READ),
    );
  }

  @ApiOperation({
    summary: 'Create or update customer profile',
    description:
      '**Protected — `crm.customers.manage`. Clinic active.** Upserts the 1:1 profile. ' +
      'T108 (spec 014, US6, FR-H010a) — submitting any of the 4 clinical fields ' +
      '(medical_history, allergies, blood_type, notes) additionally requires ' +
      '`clinical.records.manage`, or the request is refused (403), never silently dropped.',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Customer profile saved.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `crm.customers.manage`, or clinic inactive, or attempted a clinical field without `clinical.records.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Put()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  upsert(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: UpdateCustomerProfileDto,
  ) {
    return this.profiles.upsert(
      this.ctx.requireTenantId(),
      customerId,
      dto,
      this.hasClinical(PERMISSION.CLINICAL_RECORDS_MANAGE),
    );
  }
}
