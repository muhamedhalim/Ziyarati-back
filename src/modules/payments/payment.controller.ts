import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { QueryPaymentsDto } from './dto/query-payments.dto';

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
 * Payments. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id always
 * from TenantContext (never request input). The gateway is reached only through
 * the provider abstraction.
 */
@ApiTags('Payments')
@ApiBearerAuth('JWT-auth')
@Controller('payments')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a payment',
    description:
      '**Protected — `payments.manage`. Clinic active.** Creates a PENDING payment for the caller tenant and initiates it with the gateway (provider abstraction). Pass `idempotencyKey` to make retries safe.',
  })
  @ApiOkResponse({ description: 'Payment created (PENDING or immediately captured).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.manage`, or clinic inactive.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.PAYMENTS_MANAGE)
  create(@Body() dto: CreatePaymentDto) {
    return this.payments.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Confirm / verify a payment',
    description:
      '**Protected — `payments.manage`. Clinic active.** Verifies the payment with the gateway and settles its status (idempotent; PAID stays PAID).',
  })
  @ApiParam({ name: 'id', description: 'Payment UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Payment after verification.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Payment not found in this tenant.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Payment not in a confirmable state.', schema: S_ERROR })
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PAYMENTS_MANAGE)
  confirm(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmPaymentDto) {
    return this.payments.confirm(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Get payment status',
    description: '**Protected — `payments.read`. Clinic active.** Lightweight status view for a single payment.',
  })
  @ApiParam({ name: 'id', description: 'Payment UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Payment status.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Payment not found in this tenant.', schema: S_ERROR })
  @Get(':id/status')
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  getStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.getStatus(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'List payments',
    description: '**Protected — `payments.read`. Clinic active.** Tenant-scoped, newest first, with status/date filters and pagination.',
  })
  @ApiOkResponse({ description: 'Paginated payments.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  list(@Query() query: QueryPaymentsDto) {
    return this.payments.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get payment details',
    description: '**Protected — `payments.read`. Clinic active.** A payment from another tenant returns 404.',
  })
  @ApiParam({ name: 'id', description: 'Payment UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Payment details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Payment not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.findOne(this.ctx.requireTenantId(), id);
  }
}
