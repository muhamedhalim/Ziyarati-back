import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { RefundService } from './refund.service';
import { CreateRefundDto } from './dto/create-refund.dto';
import { QueryRefundsDto } from './dto/query-refunds.dto';

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
 * Refunds. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id from
 * TenantContext. Creating a refund requires `refunds.manage`.
 */
@ApiTags('Refunds')
@ApiBearerAuth('JWT-auth')
@Controller('refunds')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class RefundController {
  constructor(
    private readonly refunds: RefundService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a refund (full or partial)',
    description:
      '**Protected — `refunds.manage`. Clinic active.** Refunds a paid payment through the gateway abstraction. Omit `amount` for a full refund of the remaining balance; partial refunds advance the payment to PARTIALLY_REFUNDED. A gateway decline returns 422 and persists nothing.',
  })
  @ApiCreatedResponse({ description: 'Refund created.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `refunds.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Payment not found in this tenant.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Payment not refundable, amount exceeds remaining, or gateway declined.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.REFUNDS_MANAGE)
  create(@Body() dto: CreateRefundDto) {
    return this.refunds.create(
      this.ctx.requireTenantId(),
      dto,
      this.ctx.getUser()?.id,
    );
  }

  @ApiOperation({
    summary: 'List refunds',
    description: '**Protected — `payments.read`. Clinic active.** Tenant-scoped, newest first, with optional payment/status filters.',
  })
  @ApiOkResponse({ description: 'Paginated refunds.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  list(@Query() query: QueryRefundsDto) {
    return this.refunds.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get refund details',
    description: '**Protected — `payments.read`. Clinic active.** A refund from another tenant returns 404.',
  })
  @ApiParam({ name: 'id', description: 'Refund UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Refund details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Refund not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.findOne(this.ctx.requireTenantId(), id);
  }
}
