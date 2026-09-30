import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

import {
  DeleteSalesTargetQueryDto,
  QuerySalesTargetsDto,
} from './dto/query-sales-targets.dto';
import { QueryTargetRevisionsDto } from './dto/query-target-revisions.dto';
import { SetSalesTargetDto } from './dto/set-sales-target.dto';
import { SalesTargetService, assertSalesMetric } from './sales-target.service';

/**
 * Monthly targets and their history. SUPER ADMIN ONLY, by role. The employee
 * is always the one in the path (re-verified as a live `platform_sales` user),
 * and a target is addressed by (employee, month, metric) — never by a bare
 * target id — so one employee's target can never be reached through another's.
 */
@ApiTags('Platform Sales')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class SalesTargetsController {
  constructor(private readonly targets: SalesTargetService) {}

  @ApiOperation({
    summary: "An employee's targets with progress, month by month (super admin)",
  })
  @Get('employees/:id/targets')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QuerySalesTargetsDto,
  ) {
    return this.targets.list(id, query.from, query.to);
  }

  @ApiOperation({ summary: 'Target change history of an employee (super admin)' })
  @Get('employees/:id/target-revisions')
  revisions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryTargetRevisionsDto,
  ) {
    return this.targets.revisions(id, query);
  }

  @ApiOperation({ summary: 'Create or update one monthly target (super admin)' })
  @Put('employees/:id/targets/:period/:metric')
  set(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('period') period: string,
    @Param('metric') metric: string,
    @Body() dto: SetSalesTargetDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.targets.upsert(id, period, assertSalesMetric(metric), dto, actorId);
  }

  @ApiOperation({
    summary: 'Clear a target of the current or a future month (super admin)',
  })
  @Delete('employees/:id/targets/:period/:metric')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('period') period: string,
    @Param('metric') metric: string,
    @Query() query: DeleteSalesTargetQueryDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.targets.remove(
      id,
      period,
      assertSalesMetric(metric),
      query.reason,
      actorId,
    );
  }
}
