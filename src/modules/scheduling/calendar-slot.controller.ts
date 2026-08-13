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

import { CalendarSlotService } from './calendar-slot.service';
import { CreateCalendarSlotDto } from './dto/create-calendar-slot.dto';
import { UpdateCalendarSlotDto } from './dto/update-calendar-slot.dto';
import { CalendarSlotFilterDto } from './dto/calendar-slot-filter.dto';

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
 * Calendar slots (availability windows). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id always from TenantContext.
 */
@ApiTags('Scheduling Calendar Slots')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.SCHEDULING)
@Controller('scheduling/slots')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CalendarSlotController {
  constructor(
    private readonly slots: CalendarSlotService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a calendar slot',
    description:
      '**Protected — `scheduling.slots.manage`. Clinic active.** Branch + staff are tenant-validated; end must be after start.',
  })
  @ApiCreatedResponse({ description: 'Slot created.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.slots.manage`, or clinic inactive.',
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
  @RequirePermissions(PERMISSION.SCHEDULING_SLOTS_MANAGE)
  create(@Body() dto: CreateCalendarSlotDto) {
    return this.slots.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List calendar slots',
    description:
      '**Protected — `scheduling.slots.read`. Clinic active.** Tenant-scoped, with branch/staff/availability/date filters, sort + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated slots.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.slots.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.SCHEDULING_SLOTS_READ)
  list(@Query() filter: CalendarSlotFilterDto) {
    return this.slots.list(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get slot details',
    description:
      "**Protected — `scheduling.slots.read`. Clinic active.** Another tenant's slot returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Slot details.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.slots.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Slot not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.SCHEDULING_SLOTS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.slots.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a calendar slot',
    description: '**Protected — `scheduling.slots.manage`. Clinic active.**',
  })
  @ApiParam({
    name: 'id',
    description: 'Slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Slot updated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.slots.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Slot, branch or staff not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Invalid time range.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequirePermissions(PERMISSION.SCHEDULING_SLOTS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCalendarSlotDto,
  ) {
    return this.slots.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Delete a calendar slot',
    description: '**Protected — `scheduling.slots.manage`. Clinic active.**',
  })
  @ApiParam({
    name: 'id',
    description: 'Slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Slot deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.slots.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Slot not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SCHEDULING_SLOTS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.slots.remove(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Enable a calendar slot',
    description:
      '**Protected — `scheduling.slots.manage`. Clinic active.** Sets the slot available.',
  })
  @ApiParam({
    name: 'id',
    description: 'Slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Slot enabled.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.slots.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Slot not found in this tenant.',
    schema: S_ERROR,
  })
  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SCHEDULING_SLOTS_MANAGE)
  enable(@Param('id', ParseUUIDPipe) id: string) {
    return this.slots.enable(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Disable a calendar slot',
    description:
      '**Protected — `scheduling.slots.manage`. Clinic active.** Sets the slot unavailable.',
  })
  @ApiParam({
    name: 'id',
    description: 'Slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Slot disabled.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `scheduling.slots.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Slot not found in this tenant.',
    schema: S_ERROR,
  })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SCHEDULING_SLOTS_MANAGE)
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.slots.disable(this.ctx.requireTenantId(), id);
  }
}
