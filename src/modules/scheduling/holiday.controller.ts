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
} from '@nestjs/swagger';

import { HolidayService } from './holiday.service';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { HolidayFilterDto } from './dto/holiday-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

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
 * Holidays. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id always
 * from TenantContext.
 */
@ApiTags('Scheduling Holidays')
@ApiBearerAuth('JWT-auth')
@Controller('scheduling/holidays')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class HolidayController {
  constructor(
    private readonly holidays: HolidayService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Create a holiday', description: '**Protected — `scheduling.holidays.manage`. Clinic active.** Branch optional (omit = company-wide); `isRecurring` repeats yearly.' })
  @ApiCreatedResponse({ description: 'Holiday created.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.holidays.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.SCHEDULING_HOLIDAYS_MANAGE)
  create(@Body() dto: CreateHolidayDto) {
    return this.holidays.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List holidays', description: '**Protected — `scheduling.holidays.read`. Clinic active.** Tenant-scoped, with branch/recurring/date filters + pagination.' })
  @ApiOkResponse({ description: 'Paginated holidays.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.holidays.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.SCHEDULING_HOLIDAYS_READ)
  list(@Query() filter: HolidayFilterDto) {
    return this.holidays.list(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Get holiday details', description: '**Protected — `scheduling.holidays.read`. Clinic active.** Another tenant\'s holiday returns 404.' })
  @ApiParam({ name: 'id', description: 'Holiday UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Holiday details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.holidays.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Holiday not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.SCHEDULING_HOLIDAYS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.holidays.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update a holiday', description: '**Protected — `scheduling.holidays.manage`. Clinic active.**' })
  @ApiParam({ name: 'id', description: 'Holiday UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Holiday updated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.holidays.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Holiday or branch not found in this tenant.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.SCHEDULING_HOLIDAYS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHolidayDto) {
    return this.holidays.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Delete a holiday', description: '**Protected — `scheduling.holidays.manage`. Clinic active.**' })
  @ApiParam({ name: 'id', description: 'Holiday UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Holiday deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.holidays.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Holiday not found in this tenant.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SCHEDULING_HOLIDAYS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.holidays.remove(this.ctx.requireTenantId(), id);
  }
}
