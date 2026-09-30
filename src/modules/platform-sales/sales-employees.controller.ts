import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

import { QuerySalesEmployeesDto } from './dto/query-sales-employees.dto';
import { SalesOverviewQueryDto } from './dto/sales-overview-query.dto';
import { SalesEmployeeService } from './sales-employee.service';

/**
 * Sales team read side. SUPER ADMIN ONLY, by role — like `/platform/staff`,
 * this surface is role-gated rather than permission-gated, and the
 * `platform_sales` role itself holds no permission slug. Creating, editing,
 * (de)activating and inviting employees stays on `/platform/staff`.
 */
@ApiTags('Platform Sales')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class SalesEmployeesController {
  constructor(private readonly employees: SalesEmployeeService) {}

  @ApiOperation({ summary: 'Sales team overview counts (super admin)' })
  @Get('overview')
  overview(@Query() query: SalesOverviewQueryDto) {
    return this.employees.overview(query.period);
  }

  @ApiOperation({ summary: 'List sales employees with portfolio stats (super admin)' })
  @Get('employees')
  list(@Query() query: QuerySalesEmployeesDto) {
    return this.employees.list(query);
  }

  @ApiOperation({ summary: 'One sales employee with portfolio stats (super admin)' })
  @Get('employees/:id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SalesOverviewQueryDto,
  ) {
    return this.employees.detail(id, query.period);
  }
}
