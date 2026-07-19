import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { MerchantAccountService } from './merchant-account.service';
import { SubmitMerchantAccountDto } from './dto/submit-merchant-account.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';

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
 * Clinic-side merchant (financial) onboarding. Tenant-scoped: a clinic sees and
 * submits ONLY its own account; eligibility decisions are platform-admin only
 * (MerchantAccountAdminController).
 */
@ApiTags('Merchant Account')
@ApiBearerAuth('JWT-auth')
@Controller('payments/merchant-account')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class MerchantAccountController {
  constructor(
    private readonly merchants: MerchantAccountService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Get this clinic’s merchant onboarding status',
    description:
      '**Protected — `payments.read`. Clinic active.** The clinic’s financial onboarding record (status, masked bank details). A missing record reads as NOT_STARTED.',
  })
  @ApiOkResponse({ description: 'Merchant account.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  get() {
    return this.merchants.getForTenant(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Submit financial details for review',
    description:
      '**Protected — `payments.manage`. Clinic active.** Moves the account to SUBMITTED. The IBAN is stored masked (last 4) — the bank certificate itself is uploaded via verification documents.',
  })
  @ApiOkResponse({ description: 'Merchant account after submission.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Account not in a submittable status.', schema: S_ERROR })
  @Post('submit')
  @RequirePermissions(PERMISSION.PAYMENTS_MANAGE)
  submit(@Body() dto: SubmitMerchantAccountDto) {
    return this.merchants.submit(
      this.ctx.requireTenantId(),
      dto,
      this.ctx.getUser()?.id,
    );
  }
}
