import {
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { MarketplaceFinanceService } from './marketplace-finance.service';
import {
  FinancialAuditService,
  FINANCIAL_AUDIT_ACTION,
} from './financial-audit.service';
import { QueryMarketplaceTransactionsDto } from './dto/query-marketplace-transactions.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Marketplace Financial Operations — platform owner (super-admin) only.
 *
 * READ-ONLY reporting over the existing payments ledger. Server-side paginated /
 * filtered / sorted. View + export are written to the financial audit trail.
 */
@ApiTags('Marketplace Finance (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/finance')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformFinanceController {
  constructor(
    private readonly finance: MarketplaceFinanceService,
    private readonly audit: FinancialAuditService,
  ) {}

  @ApiOperation({ summary: 'Marketplace KPI cards (super-admin)' })
  @ApiOkResponse({ description: 'Revenue / split / payout / refund gauges.' })
  @Get('kpis')
  kpis() {
    return this.finance.kpis();
  }

  @ApiOperation({ summary: 'List marketplace transactions (super-admin)' })
  @ApiOkResponse({
    description: 'Server-paginated, filtered, sorted transactions.',
  })
  @Get('transactions')
  list(@Query() query: QueryMarketplaceTransactionsDto) {
    return this.finance.listTransactions(query);
  }

  @ApiOperation({
    summary: 'Export filtered transactions as CSV (super-admin)',
  })
  @ApiOkResponse({
    description: '{ filename, content } CSV payload (Excel-native).',
  })
  @Get('transactions/export')
  async export(
    @Query() query: QueryMarketplaceTransactionsDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.finance.exportCsv(query);
    await this.audit.record(
      FINANCIAL_AUDIT_ACTION.EXPORT,
      userId,
      ip,
      undefined,
      {
        filters: { ...query },
        rows: result.content.split('\n').length - 1,
      },
    );
    return result;
  }

  @ApiOperation({
    summary: 'Transaction detail with timeline + webhooks (super-admin)',
  })
  @ApiOkResponse({
    description: 'Full transaction breakdown for the detail drawer.',
  })
  @Get('transactions/:id')
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.finance.getTransaction(id);
    await this.audit.record(FINANCIAL_AUDIT_ACTION.VIEW, userId, ip, id);
    return result;
  }

  @ApiOperation({
    summary: 'KPI drill-down (super-admin)',
    description:
      'Rich drill-down for a dashboard KPI (`:metric` from the finance metric registry): summary, totals, statistics, charts (daily/monthly/status), breakdowns (clinic/branch/gateway/method/service) and the underlying transactions — all server-side filtered/sorted/paginated. Reuses the transactions filter DTO.',
  })
  @ApiParam({
    name: 'metric',
    description: 'KPI key, e.g. platformRevenue, refunds, moneyWaitingPayout.',
  })
  @ApiOkResponse({ description: 'Metric drill-down payload.' })
  @Get('metrics/:metric')
  async metricDrilldown(
    @Param('metric') metric: string,
    @Query() query: QueryMarketplaceTransactionsDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.finance.metricDrilldown(metric, query);
    await this.audit.record(
      FINANCIAL_AUDIT_ACTION.VIEW,
      userId,
      ip,
      undefined,
      { metric },
    );
    return result;
  }

  @ApiOperation({ summary: 'Per-clinic financial summary (super-admin)' })
  @ApiOkResponse({
    description: 'Totals, fees, refunds, growth, daily/monthly series.',
  })
  @Get('clinics/:tenantId/summary')
  clinicSummary(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.finance.clinicSummary(tenantId);
  }
}
