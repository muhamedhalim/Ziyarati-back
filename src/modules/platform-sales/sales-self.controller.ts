import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

import { QueryEmployeeClinicsDto } from './dto/query-employee-clinics.dto';
import { QuerySalesTargetsDto } from './dto/query-sales-targets.dto';
import {
  CreateSalesActivityDto,
  QuerySalesActivitiesDto,
} from './dto/sales-activity-dtos';
import { QueryBonusPreviewDto, QuerySalesBonusesDto } from './dto/sales-bonus-dtos';
import { SalesOverviewQueryDto } from './dto/sales-overview-query.dto';
import { SalesSelfService } from './sales-self.service';

/**
 * The sales rep's own console API. PLATFORM_SALES ONLY, by role (the role holds
 * no permission slug, like the rest of this module). Super Admin is NOT
 * admitted: it has no sales identity, and its view of any rep is the
 * `employees/:id` surface.
 *
 * There is no employee id anywhere in these routes, in the query or in a body —
 * the rep is always the authenticated user — so one rep can never reach another
 * rep's data. Read-only, except for logging the rep's own activity.
 */
@ApiTags('Platform Sales (self)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales/me')
@UseGuards(RolesGuard)
@Roles(ROLE.PLATFORM_SALES)
export class SalesSelfController {
  constructor(private readonly self: SalesSelfService) {}

  @ApiOperation({ summary: 'My profile and this month’s progress (sales rep)' })
  @Get()
  profile(@CurrentUser('id') userId: string, @Query() query: SalesOverviewQueryDto) {
    return this.self.profile(userId, query.period);
  }

  @ApiOperation({ summary: 'My clinics (sales rep)' })
  @Get('clinics')
  clinics(@CurrentUser('id') userId: string, @Query() query: QueryEmployeeClinicsDto) {
    return this.self.clinics(userId, query);
  }

  @ApiOperation({ summary: 'My targets with progress, month by month (sales rep)' })
  @Get('targets')
  targets(@CurrentUser('id') userId: string, @Query() query: QuerySalesTargetsDto) {
    return this.self.targetsFor(userId, query);
  }

  @ApiOperation({ summary: 'What my bonus rules pay for a month (sales rep)' })
  @Get('bonus-preview')
  bonusPreview(@CurrentUser('id') userId: string, @Query() query: QueryBonusPreviewDto) {
    return this.self.bonusPreview(userId, query);
  }

  @ApiOperation({ summary: 'My approved and paid bonuses (sales rep)' })
  @Get('bonuses')
  bonuses(@CurrentUser('id') userId: string, @Query() query: QuerySalesBonusesDto) {
    return this.self.bonusRecords(userId, query);
  }

  @ApiOperation({ summary: 'My logged field activity, newest first (sales rep)' })
  @Get('activities')
  activities(@CurrentUser('id') userId: string, @Query() query: QuerySalesActivitiesDto) {
    return this.self.activityList(userId, query);
  }

  @ApiOperation({ summary: 'Log my own visit, call, meeting, demo or follow-up (sales rep)' })
  @Post('activities')
  logActivity(@CurrentUser('id') userId: string, @Body() dto: CreateSalesActivityDto) {
    return this.self.logActivity(userId, dto);
  }
}
