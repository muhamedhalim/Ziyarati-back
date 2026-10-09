import { Injectable } from '@nestjs/common';

import type { CreateSalesActivityDto, QuerySalesActivitiesDto } from './dto/sales-activity-dtos';
import type { QueryBonusPreviewDto, QuerySalesBonusesDto } from './dto/sales-bonus-dtos';
import type { QueryEmployeeClinicsDto } from './dto/query-employee-clinics.dto';
import type { QuerySalesTargetsDto } from './dto/query-sales-targets.dto';
import { SalesActivityService } from './sales-activity.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesBonusService } from './sales-bonus.service';
import { SalesEmployeeService } from './sales-employee.service';
import { currentSalesPeriod } from './sales-period.util';
import { SalesTargetService } from './sales-target.service';
import type {
  Paged,
  SalesBonusRecordItem,
  SalesBonusPreviewItem,
  SalesMetricRow,
} from './sales.types';
import type {
  SalesSelfActivityItem,
  SalesSelfBonusList,
  SalesSelfBonusMonth,
  SalesSelfBonusPreviewItem,
  SalesSelfBonusRecord,
  SalesSelfMetricRow,
  SalesSelfPortfolioItem,
  SalesSelfProfile,
  SalesSelfTargets,
} from './sales-self.types';

function toSelfRecord(r: SalesBonusRecordItem): SalesSelfBonusRecord {
  return {
    id: r.id,
    period: r.period,
    metric: r.metric,
    targetValue: r.targetValue,
    achievedValue: r.achievedValue,
    achievementPct: r.achievementPct,
    amount: r.amount,
    currency: r.currency,
    // Voided records are filtered out upstream; a void one never reaches a rep.
    status: r.status === 'paid' ? 'paid' : 'approved',
    approvedAt: r.approvedAt,
    paidMarkedAt: r.paidMarkedAt,
  };
}

function toSelfPreviewItem(i: SalesBonusPreviewItem): SalesSelfBonusPreviewItem {
  return {
    metric: i.metric,
    period: i.period,
    target: i.target,
    achieved: i.achieved,
    percentage: i.percentage,
    currency: i.currency,
    rule: i.rule,
    applicable: i.applicable,
    thresholdMet: i.thresholdMet,
    amount: i.amount,
    bonusCurrency: i.bonusCurrency,
    excludedCurrencies: i.excludedCurrencies,
    state: i.state,
    record: i.record && i.record.status !== 'void' ? toSelfRecord(i.record) : null,
  };
}

function toSelfMetric(m: SalesMetricRow): SalesSelfMetricRow {
  // Built field by field: the admin row carries ids and a lock/version used only for editing.
  return {
    metric: m.metric,
    period: m.period,
    target: m.target,
    currency: m.currency,
    achieved: m.achieved,
    remaining: m.remaining,
    percentage: m.percentage,
    isCompleted: m.isCompleted,
    expectedPercentage: m.expectedPercentage,
    onTrack: m.onTrack,
    bonusRule: m.bonusRule,
    locked: m.locked,
    excludedCurrencies: m.excludedCurrencies,
    updatedAt: m.updatedAt,
  };
}

/**
 * The signed-in sales rep's own view of the sales data.
 *
 * A thin facade over the admin services: every method takes the rep's id from
 * the AUTHENTICATED user (the controller never accepts an employee id), calls
 * the same query code the Super Admin console uses, and maps the result onto
 * the `Self` types so admin-only fields cannot leak. Nothing here duplicates
 * a query.
 */
@Injectable()
export class SalesSelfService {
  constructor(
    private readonly employees: SalesEmployeeService,
    private readonly assignments: SalesAssignmentService,
    private readonly targets: SalesTargetService,
    private readonly bonuses: SalesBonusService,
    private readonly activities: SalesActivityService,
  ) {}

  async profile(userId: string, period?: string): Promise<SalesSelfProfile> {
    // `requireActive`: a deactivated rep is refused here as well as by the auth layer.
    await this.employees.requireEmployee(userId, { requireActive: true });
    const d = await this.employees.detail(userId, period);
    return {
      id: d.id,
      email: d.email,
      fullName: d.fullName,
      phone: d.phone,
      period: period ?? currentSalesPeriod().period,
      assignedCount: d.assignedCount,
      lastActivityAt: d.lastActivityAt,
      targets: d.targets,
      bonusPreview: d.bonusPreview,
    };
  }

  async clinics(
    userId: string,
    query: QueryEmployeeClinicsDto,
  ): Promise<Paged<SalesSelfPortfolioItem>> {
    await this.employees.requireEmployee(userId, { requireActive: true });
    const page = await this.assignments.listEmployeeClinics(userId, query);
    return {
      ...page,
      data: page.data.map(({ note: _note, ...rest }) => rest),
    };
  }

  async targetsFor(userId: string, query: QuerySalesTargetsDto): Promise<SalesSelfTargets> {
    await this.employees.requireEmployee(userId, { requireActive: true });
    const t = await this.targets.list(userId, query.from, query.to);
    return {
      from: t.from,
      to: t.to,
      billingLive: t.billingLive,
      months: t.months.map((m) => ({
        period: m.period,
        phase: m.phase,
        metrics: m.metrics.map(toSelfMetric),
      })),
    };
  }

  async bonusPreview(userId: string, query: QueryBonusPreviewDto): Promise<SalesSelfBonusMonth> {
    await this.employees.requireEmployee(userId, { requireActive: true });
    const m = await this.bonuses.preview(userId, query.period);
    return {
      period: m.period,
      phase: m.phase,
      billingLive: m.billingLive,
      items: m.items.map(toSelfPreviewItem),
    };
  }

  async bonusRecords(userId: string, query: QuerySalesBonusesDto): Promise<SalesSelfBonusList> {
    await this.employees.requireEmployee(userId, { requireActive: true });
    const list = await this.bonuses.list(userId, query, { excludeVoid: true });
    return {
      data: list.data.map(toSelfRecord),
      total: list.total,
      page: list.page,
      limit: list.limit,
      totals: list.totals,
    };
  }

  async activityList(
    userId: string,
    query: QuerySalesActivitiesDto,
  ): Promise<Paged<SalesSelfActivityItem>> {
    await this.employees.requireEmployee(userId, { requireActive: true });
    const page = await this.activities.list(userId, query);
    return {
      ...page,
      data: page.data.map(({ recordedBy: _by, ...rest }) => rest),
    };
  }

  async logActivity(
    userId: string,
    dto: CreateSalesActivityDto,
  ): Promise<SalesSelfActivityItem> {
    const created = await this.activities.create(userId, dto, userId, { source: 'self' });
    const { recordedBy: _by, ...rest } = created;
    return rest;
  }
}
