import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { MerchantAccountService } from './merchant-account.service';
import { SubmitMerchantAccountDto } from './dto/submit-merchant-account.dto';
import { StartTapOnboardingDto } from './dto/start-tap-onboarding.dto';
import { TapOnboardingService } from './tap-onboarding.service';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
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
 * Clinic-side merchant (financial) onboarding. Tenant-scoped: a clinic sees and
 * submits ONLY its own account; eligibility decisions are platform-admin only
 * (MerchantAccountAdminController).
 */
@ApiTags('Merchant Account')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.PAYMENTS)
@Controller('payments/merchant-account')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class MerchantAccountController {
  constructor(
    private readonly merchants: MerchantAccountService,
    private readonly tapOnboarding: TapOnboardingService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Get this clinic’s merchant onboarding status',
    description:
      '**Protected — `payments.read`. Clinic active.** The clinic’s financial onboarding record (status, masked bank details) plus `online_payments`: whether Tap onboarding can be started and whether patients can pay this clinic online right now. A missing record reads as NOT_STARTED.',
  })
  @ApiOkResponse({ description: 'Merchant account.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `payments.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  get() {
    return this.merchants.getClinicView(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Submit financial details for review',
    description:
      '**Protected — `payments.manage`. Clinic active.** Moves the account to SUBMITTED. The IBAN is stored masked (last 4) — the bank certificate itself is uploaded via verification documents.',
  })
  @ApiOkResponse({ description: 'Merchant account after submission.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `payments.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Account not in a submittable status.',
    schema: S_ERROR,
  })
  @Post('submit')
  @RequirePermissions(PERMISSION.PAYMENTS_MANAGE)
  submit(@Body() dto: SubmitMerchantAccountDto) {
    return this.merchants.submit(
      this.ctx.requireTenantId(),
      dto,
      this.ctx.getUser()?.id,
    );
  }

  @ApiOperation({
    summary: 'Start (or resume) Tap online-payment onboarding',
    description:
      '**Protected — `payments.manage`. Clinic active.** Creates the clinic’s Tap lead (once) and returns the URL of Tap’s hosted onboarding page — redirect the browser there. KYC, national ID and bank details are entered on Tap’s page and never reach ZiyaraTech. The clinic can pay patients’ bookings online only after a platform admin has approved the resulting merchant.',
  })
  @ApiOkResponse({
    description: 'Tap’s hosted onboarding URL.',
    schema: {
      type: 'object',
      properties: {
        connectUrl: {
          type: 'string',
          example: 'https://connect.tap.company/…',
        },
        status: { type: 'string', example: 'PENDING_DOCUMENTS' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `payments.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Onboarding is unavailable, or the account status does not allow it.',
    schema: S_ERROR,
  })
  @ApiServiceUnavailableResponse({
    description: 'Tap is temporarily unavailable.',
    schema: S_ERROR,
  })
  @Post('tap/connect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PAYMENTS_MANAGE)
  connectTap(@Body() dto: StartTapOnboardingDto) {
    return this.tapOnboarding.start(
      this.ctx.requireTenantId(),
      this.ctx.getUser()?.id,
      dto.locale,
    );
  }
}
