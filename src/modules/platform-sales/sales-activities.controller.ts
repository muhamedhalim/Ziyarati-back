import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

import {
  CreateSalesActivityDto,
  QuerySalesActivitiesDto,
} from './dto/sales-activity-dtos';
import { SalesActivityService } from './sales-activity.service';

/**
 * The field-activity log. SUPER ADMIN ONLY, by role. Every activity is reached
 * through the employee in the path, so one employee's log can never be read or
 * changed through another's.
 */
@ApiTags('Platform Sales')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class SalesActivitiesController {
  constructor(private readonly activities: SalesActivityService) {}

  @ApiOperation({ summary: "An employee's logged field activity, newest first (super admin)" })
  @Get('employees/:id/activities')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QuerySalesActivitiesDto,
  ) {
    return this.activities.list(id, query);
  }

  @ApiOperation({ summary: 'Log a visit, call, meeting, demo or follow-up (super admin)' })
  @Post('employees/:id/activities')
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSalesActivityDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.activities.create(id, dto, actorId);
  }

  @ApiOperation({ summary: 'Remove a logged activity (soft delete, audited) (super admin)' })
  @Delete('employees/:id/activities/:activityId')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.activities.remove(id, activityId, actorId);
  }
}
