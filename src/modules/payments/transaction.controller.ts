import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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

import { TransactionService } from './transaction.service';
import { QueryTransactionsDto } from './dto/query-transactions.dto';

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
 * Gateway transactions (read-only audit trail). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext.
 */
@ApiTags('Transactions')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.PAYMENTS)
@Controller('transactions')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class TransactionController {
  constructor(
    private readonly transactions: TransactionService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List transactions',
    description:
      '**Protected — `payments.read`. Clinic active.** Tenant-scoped gateway interaction log, newest first, with payment/type/status filters.',
  })
  @ApiOkResponse({ description: 'Paginated transactions.' })
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
  list(@Query() query: QueryTransactionsDto) {
    return this.transactions.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get transaction details',
    description:
      "**Protected — `payments.read`. Clinic active.** Includes the stored raw provider response. Another tenant's transaction returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Transaction UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Transaction details.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `payments.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Transaction not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.PAYMENTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.transactions.findOneForClient(this.ctx.requireTenantId(), id);
  }
}
