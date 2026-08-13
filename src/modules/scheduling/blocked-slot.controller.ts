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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { BlockedSlotService } from './blocked-slot.service';
import { CreateBlockedSlotDto } from './dto/create-blocked-slot.dto';
import { UpdateBlockedSlotDto } from './dto/update-blocked-slot.dto';
import { BlockedSlotFilterDto } from './dto/blocked-slot-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
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
 * Blocked periods. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id
 * always from TenantContext.
 */
@ApiTags('Scheduling Blocked Slots')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.SCHEDULING)
@Controller('scheduling/blocked-slots')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class BlockedSlotController {
  constructor(
    private readonly blocks: BlockedSlotService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a blocked period',
    description:
      '**Protected — `scheduling.blocked.manage`. Clinic active.** Branch/staff optional (tenant/branch/staff-wide); references tenant-validated; end after start.',
  })
  @ApiCreatedResponse({ description: 'Blocked period created.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `scheduling.blocked.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Branch or staff not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Invalid time range.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.SCHEDULING_BLOCKED_MANAGE)
  create(@Body() dto: CreateBlockedSlotDto) {
    return this.blocks.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List blocked periods',
    description:
      '**Protected — `scheduling.blocked.read`. Clinic active.** Tenant-scoped, with branch/staff/date filters + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated blocked periods.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.blocked.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.SCHEDULING_BLOCKED_READ)
  list(@Query() filter: BlockedSlotFilterDto) {
    return this.blocks.list(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get blocked period details',
    description:
      "**Protected — `scheduling.blocked.read`. Clinic active.** Another tenant's block returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Blocked slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Blocked period details.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.blocked.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Blocked period not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.SCHEDULING_BLOCKED_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.blocks.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a blocked period',
    description: '**Protected — `scheduling.blocked.manage`. Clinic active.**',
  })
  @ApiParam({
    name: 'id',
    description: 'Blocked slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Blocked period updated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `scheduling.blocked.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Block, branch or staff not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Invalid time range.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequirePermissions(PERMISSION.SCHEDULING_BLOCKED_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBlockedSlotDto,
  ) {
    return this.blocks.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Delete a blocked period',
    description: '**Protected — `scheduling.blocked.manage`. Clinic active.**',
  })
  @ApiParam({
    name: 'id',
    description: 'Blocked slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Blocked period deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `scheduling.blocked.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Blocked period not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SCHEDULING_BLOCKED_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.blocks.remove(this.ctx.requireTenantId(), id);
  }
}
