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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

import { AssignClinicsDto } from './dto/assign-clinics.dto';
import {
  EndAssignmentsDto,
  TransferAssignmentsDto,
} from './dto/end-assignments.dto';
import { QueryEmployeeClinicsDto } from './dto/query-employee-clinics.dto';
import { QuerySalesClinicsDto } from './dto/query-sales-clinics.dto';
import { SalesPageQueryDto } from './dto/sales-page-query.dto';
import { SalesAssignmentService } from './sales-assignment.service';

/**
 * Clinic ownership. SUPER ADMIN ONLY, by role. Employee ids in the path are
 * always re-verified server-side as live `platform_sales` users; clinic ids in
 * bodies are the objects being assigned and are verified against the database.
 */
@ApiTags('Platform Sales')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class SalesAssignmentsController {
  constructor(private readonly assignments: SalesAssignmentService) {}

  @ApiOperation({
    summary: 'Clinic picker: clinics with their current sales owner (super admin)',
  })
  @Get('clinics')
  pickClinics(@Query() query: QuerySalesClinicsDto) {
    return this.assignments.listClinics(query);
  }

  @ApiOperation({ summary: "A clinic's full sales-ownership history (super admin)" })
  @Get('clinics/:tenantId/assignments')
  clinicHistory(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: SalesPageQueryDto,
  ) {
    return this.assignments.clinicHistory(tenantId, query);
  }

  @ApiOperation({ summary: "One employee's clinic portfolio (super admin)" })
  @Get('employees/:id/clinics')
  employeeClinics(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryEmployeeClinicsDto,
  ) {
    return this.assignments.listEmployeeClinics(id, query);
  }

  @ApiOperation({
    summary: 'Assign clinics to an employee (super admin)',
    description:
      'Bulk (max 200). One transaction; a clinic another employee owns is skipped unless `onConflict` is `reassign`. Returns per-clinic skip reasons.',
  })
  @Post('employees/:id/assignments')
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignClinicsDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.assignments.assign(id, dto, actorUserId);
  }

  @ApiOperation({
    summary: "Hand an employee's clinics to another employee (super admin)",
  })
  @HttpCode(HttpStatus.OK)
  @Post('employees/:id/assignments/transfer')
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferAssignmentsDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.assignments.transfer(id, dto, actorUserId);
  }

  @ApiOperation({
    summary: 'End assignments — the clinics become unowned (super admin)',
    description: 'Idempotent: already-ended or unknown ids are reported, not errors.',
  })
  @HttpCode(HttpStatus.OK)
  @Post('assignments/end')
  end(@Body() dto: EndAssignmentsDto, @CurrentUser('id') actorUserId: string) {
    return this.assignments.end(dto, actorUserId);
  }
}
