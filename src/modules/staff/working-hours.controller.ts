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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { StaffScheduleService } from './staff-schedule.service';
import { CreateWorkingHoursDto } from './dto/create-working-hours.dto';
import { UpdateWorkingHoursDto } from './dto/update-working-hours.dto';

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

const S_WORKING_HOURS = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    day_of_week: { type: 'number', example: 1, description: '0=Sunday … 6=Saturday' },
    start_time: { type: 'string', example: '08:00' },
    end_time: { type: 'string', example: '18:00' },
    is_closed: { type: 'boolean', example: false },
    branch: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
  },
};

/**
 * Branch operating hours (the `working_hours` table is BRANCH-scoped, not
 * per-staff). These bound when a clinic branch is open and therefore when staff
 * can be booked — they feed the staff availability computation.
 *
 * Guards: PermissionsGuard + ActiveTenantGuard. Tenant id from TenantContext.
 */
@ApiTags('Working Hours')
@ApiBearerAuth('JWT-auth')
@Controller('working-hours')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class WorkingHoursController {
  constructor(
    private readonly schedules: StaffScheduleService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Add a branch working-hours slot',
    description: `
**Protected — requires \`staff.schedule.manage\`. Clinic must be active.**

Defines one operating-hours slot for a branch on a weekday. Multiple slots
per day are allowed (e.g. a midday break = two open slots). Overlapping open
slots for the same branch + day are rejected (409). Mark \`isClosed=true\` to
represent a closed day.

**Validation:** \`endTime\` after \`startTime\`; 24h \`HH:MM\`; \`dayOfWeek\` 0–6.

**Who can call this:** Owner, Manager (\`staff.schedule.manage\`).
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Working-hours slot created.', schema: S_WORKING_HOURS })
  @ApiBadRequestResponse({ description: 'Validation failed or end ≤ start.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `staff.schedule.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch not found in this clinic.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Slot overlaps an existing open slot that day.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.STAFF_SCHEDULE_MANAGE)
  create(@Body() dto: CreateWorkingHoursDto) {
    return this.schedules.createWorkingHours(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List a branch\'s working hours',
    description: `
**Protected — requires \`staff.read\`. Clinic must be active.**

Returns the operating-hours rows for a branch, ordered by weekday then start
time.

**Who can call this:** Owner, Manager, Receptionist (\`staff.read\`).
    `.trim(),
  })
  @ApiQuery({ name: 'branchId', required: true, description: 'Branch UUID', example: 'c1d2e3f4-0000-0000-0000-000000000010' })
  @ApiOkResponse({ description: 'Working-hours rows.', schema: { type: 'array', items: S_WORKING_HOURS } })
  @ApiBadRequestResponse({ description: 'Missing/invalid branchId.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `staff.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch not found in this clinic.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.STAFF_READ)
  list(@Query('branchId', ParseUUIDPipe) branchId: string) {
    return this.schedules.listWorkingHours(this.ctx.requireTenantId(), branchId);
  }

  @ApiOperation({
    summary: 'Update a branch working-hours slot',
    description: `
**Protected — requires \`staff.schedule.manage\`. Clinic must be active.**

Partially updates a slot; the merged result is re-validated for time order
and (when open) overlap.

**Who can call this:** Owner, Manager (\`staff.schedule.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Working-hours row UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Working-hours slot updated.', schema: S_WORKING_HOURS })
  @ApiBadRequestResponse({ description: 'Validation failed or end ≤ start.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `staff.schedule.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Working-hours row or branch not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Updated slot overlaps an existing open slot.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.STAFF_SCHEDULE_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkingHoursDto) {
    return this.schedules.updateWorkingHours(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Delete a branch working-hours slot',
    description: `**Protected — requires \`staff.schedule.manage\`. Clinic must be active.** Removes an operating-hours row.`,
  })
  @ApiParam({ name: 'id', description: 'Working-hours row UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Working-hours slot deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `staff.schedule.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Working-hours row not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.STAFF_SCHEDULE_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.removeWorkingHours(this.ctx.requireTenantId(), id);
  }
}
