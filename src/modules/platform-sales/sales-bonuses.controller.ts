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

import {
  ApproveSalesBonusDto,
  QueryBonusPreviewDto,
  QuerySalesBonusesDto,
  VoidSalesBonusDto,
} from './dto/sales-bonus-dtos';
import { SalesBonusService } from './sales-bonus.service';
import { assertSalesMetric } from './sales-target.service';

/**
 * Bonuses. SUPER ADMIN ONLY, by role. The employee is always the one in the
 * path; a bonus is reached through that employee (never by a bare id), and a
 * bonus is approved by (employee, month, metric) — the amount is computed on
 * the server and no route accepts one.
 */
@ApiTags('Platform Sales')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class SalesBonusesController {
  constructor(private readonly bonuses: SalesBonusService) {}

  @ApiOperation({
    summary: "A month's bonuses: what each rule pays now, and the approved record (super admin)",
  })
  @Get('employees/:id/bonus-preview')
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryBonusPreviewDto,
  ) {
    return this.bonuses.preview(id, query.period);
  }

  @ApiOperation({ summary: "An employee's bonus records (super admin)" })
  @Get('employees/:id/bonuses')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QuerySalesBonusesDto,
  ) {
    return this.bonuses.list(id, query);
  }

  @ApiOperation({
    summary: 'Approve the bonus of a closed month — recomputed on the server (super admin)',
  })
  @Post('employees/:id/targets/:period/:metric/bonus/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('period') period: string,
    @Param('metric') metric: string,
    @Body() dto: ApproveSalesBonusDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.bonuses.approve(id, period, assertSalesMetric(metric), dto, actorId);
  }

  @ApiOperation({
    summary: 'Record that an approved bonus was paid — moves no money (super admin)',
  })
  @HttpCode(HttpStatus.OK)
  @Post('employees/:id/bonuses/:bonusId/mark-paid')
  markPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bonusId', ParseUUIDPipe) bonusId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.bonuses.markPaid(id, bonusId, actorId);
  }

  @ApiOperation({
    summary: 'Void a bonus (reason required); the target unlocks for a corrected approval (super admin)',
  })
  @HttpCode(HttpStatus.OK)
  @Post('employees/:id/bonuses/:bonusId/void')
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bonusId', ParseUUIDPipe) bonusId: string,
    @Body() dto: VoidSalesBonusDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.bonuses.voidBonus(id, bonusId, dto, actorId);
  }
}
