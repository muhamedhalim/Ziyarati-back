import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { UsageReportService } from './usage-report.service';
import { UsageAuditService, USAGE_AUDIT_ACTION } from './usage-audit.service';
import {
  CreateUsageReportScheduleDto,
  UpdateUsageReportScheduleDto,
} from './dto/usage-report-schedule.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Scheduled usage reports — super-admin (platform owner) only (PART 5). CRUD +
 * on-demand run. Automated delivery runs on the worker's repeatable tick. All
 * mutations + runs are audited.
 */
@ApiTags('Platform Usage Reports (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/usage-reports')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class UsageReportController {
  constructor(
    private readonly reports: UsageReportService,
    private readonly audit: UsageAuditService,
  ) {}

  @ApiOperation({ summary: 'List report schedules (super-admin)' })
  @ApiOkResponse({ description: 'All configured usage-report schedules.' })
  @Get()
  list() {
    return this.reports.findAll();
  }

  @ApiOperation({ summary: 'Get a report schedule (super-admin)' })
  @ApiOkResponse({ description: 'A single schedule.' })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.findOne(id);
  }

  @ApiOperation({ summary: 'Create a report schedule (super-admin)' })
  @ApiOkResponse({ description: 'The created schedule.' })
  @Post()
  async create(
    @Body() dto: CreateUsageReportScheduleDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.reports.create(dto, userId);
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, result.id, { action: 'report_schedule_create' });
    return result;
  }

  @ApiOperation({ summary: 'Update a report schedule (super-admin)' })
  @ApiOkResponse({ description: 'The updated schedule.' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUsageReportScheduleDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.reports.update(id, dto);
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, id, { action: 'report_schedule_update' });
    return result;
  }

  @ApiOperation({ summary: 'Delete a report schedule (super-admin)' })
  @ApiOkResponse({ description: 'The deleted schedule id.' })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.reports.remove(id);
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, id, { action: 'report_schedule_delete' });
    return result;
  }

  @ApiOperation({ summary: 'Run a report schedule now (super-admin)' })
  @ApiOkResponse({ description: 'Delivery status.' })
  @Post(':id/run')
  async run(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.reports.runSchedule(id);
    await this.audit.record(USAGE_AUDIT_ACTION.EXPORT, userId, ip, id, { action: 'report_run' });
    return result;
  }
}
