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

import { SettlementService } from './settlement.service';
import { GenerateSettlementDto } from './dto/generate-settlement.dto';
import { QuerySettlementsDto } from './dto/query-settlements.dto';

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
 * Settlement batches. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id
 * from TenantContext. Generation requires `settlements.manage`; reads require
 * `settlements.read`.
 */
@ApiTags('Settlements')
@ApiBearerAuth('JWT-auth')
@Controller('settlements')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class SettlementController {
  constructor(
    private readonly settlements: SettlementService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Generate a settlement batch',
    description: '**Protected — `settlements.manage`. Clinic active.** Aggregates the tenant\'s UNSETTLED, PAID payments (optionally by period/branch) into one batch, maps each payment, and flags them IN_BATCH. 422 when nothing matches.',
  })
  @ApiOkResponse({ description: 'Settlement created (with mapped items).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `settlements.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'No eligible payments to settle.', schema: S_ERROR })
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SETTLEMENTS_MANAGE)
  generate(@Body() dto: GenerateSettlementDto) {
    return this.settlements.generate(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List settlements',
    description: '**Protected — `settlements.read`. Clinic active.** Tenant-scoped, newest first, with status/date filters and pagination.',
  })
  @ApiOkResponse({ description: 'Paginated settlements.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `settlements.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.SETTLEMENTS_READ)
  list(@Query() query: QuerySettlementsDto) {
    return this.settlements.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get settlement details (with items)',
    description: '**Protected — `settlements.read`. Clinic active.** Returns the settlement and its mapped payments. Another tenant\'s settlement returns 404.',
  })
  @ApiParam({ name: 'id', description: 'Settlement UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Settlement with items.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `settlements.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Settlement not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.SETTLEMENTS_READ)
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.settlements.getOne(this.ctx.requireTenantId(), id);
  }
}
