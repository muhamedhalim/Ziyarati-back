import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { MerchantAccountService } from './merchant-account.service';
import { ReviewMerchantAccountDto } from './dto/review-merchant-account.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

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
 * PLATFORM-ONLY merchant onboarding review. Eligibility to receive money is a
 * platform decision (super admin), mirroring PaymentGatewayController's
 * ownership rule. Every transition is appended to the account's
 * `status_history` audit trail with the acting admin's user id.
 */
@ApiTags('Merchant Accounts (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('payment-merchants')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class MerchantAccountAdminController {
  constructor(
    private readonly merchants: MerchantAccountService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List all clinic merchant accounts',
    description: '**Super admin.** Every clinic’s financial onboarding state.',
  })
  @ApiOkResponse({ description: 'Merchant accounts with tenant info.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @Get()
  list() {
    return this.merchants.listAll();
  }

  @ApiOperation({
    summary: 'Get one clinic’s merchant account',
    description: '**Super admin.** A missing record reads as NOT_STARTED.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Tenant UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Merchant account.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @Get(':tenantId')
  get(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.merchants.getForTenant(tenantId);
  }

  @ApiOperation({
    summary: 'Review a clinic’s merchant account',
    description:
      '**Super admin.** Apply a status transition (validated against the onboarding state machine), set a reviewer note, and/or record the gateway-issued split recipient id.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Tenant UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Merchant account after the review action.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Illegal status transition.',
    schema: S_ERROR,
  })
  @Patch(':tenantId/review')
  review(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: ReviewMerchantAccountDto,
  ) {
    return this.merchants.review(tenantId, dto, this.ctx.getUser()?.id);
  }
}
