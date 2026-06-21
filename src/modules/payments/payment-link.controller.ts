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
} from '@nestjs/swagger';

import { PaymentLinkService } from './payment-link.service';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { QueryPaymentLinksDto } from './dto/query-payment-links.dto';

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
 * Payment links. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id from
 * TenantContext. Tokens are unguessable and resolved tenant-scoped.
 */
@ApiTags('Payment Links')
@ApiBearerAuth('JWT-auth')
@Controller('payment-links')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class PaymentLinkController {
  constructor(
    private readonly links: PaymentLinkService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Generate a payment link',
    description: '**Protected — `payments.manage`. Clinic active.** Mints an unguessable, tenant-scoped link with an optional expiry (defaults to 72h).',
  })
  @ApiOkResponse({ description: 'Payment link created.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.manage`, or clinic inactive.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.PAYMENTS_MANAGE)
  create(@Body() dto: CreatePaymentLinkDto) {
    return this.links.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List payment links',
    description: '**Protected — `payments.read`. Clinic active.** Tenant-scoped, newest first, with optional status filter and pagination.',
  })
  @ApiOkResponse({ description: 'Paginated payment links.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  list(@Query() query: QueryPaymentLinksDto) {
    return this.links.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Track a payment link by token',
    description: '**Protected — `payments.read`. Clinic active.** Returns the link state for the token (lazily marks an expired link EXPIRED).',
  })
  @ApiParam({ name: 'token', description: 'Public link token', type: 'string' })
  @ApiOkResponse({ description: 'Payment link state.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Link not found in this tenant.', schema: S_ERROR })
  @Get('token/:token')
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  getByToken(@Param('token') token: string) {
    return this.links.getByToken(this.ctx.requireTenantId(), token);
  }

  @ApiOperation({
    summary: 'Get a payment link',
    description: '**Protected — `payments.read`. Clinic active.** A link from another tenant returns 404.',
  })
  @ApiParam({ name: 'id', description: 'Payment link UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Payment link details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Link not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.links.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Disable a payment link',
    description: '**Protected — `payments.manage`. Clinic active.** Disables an active link so it can no longer be used.',
  })
  @ApiParam({ name: 'id', description: 'Payment link UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Payment link disabled.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `payments.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Link not found in this tenant.', schema: S_ERROR })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PAYMENTS_MANAGE)
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.links.disable(this.ctx.requireTenantId(), id);
  }
}
