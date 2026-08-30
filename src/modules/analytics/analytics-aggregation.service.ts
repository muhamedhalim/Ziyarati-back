import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, MoreThanOrEqual, Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { AppointmentCancellation } from '../../entities/Calendar&Appointments/AppointmentCancellation';
import { Payment } from '../../entities/Payments/Payment';
import { Customer } from '../../entities/CRM/Customer';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Conversation } from '../../entities/Conversations/Conversation';
import { CustomerReview } from '../../entities/CRM/CustomerReview';
import {
  AppointmentActionOrigin,
  AppointmentStatus,
  AppointmentSource,
  PaymentStatus,
} from '../../entities/enums';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { AppError, ErrorCode } from '../../common/errors';

import {
  ACTIVE_CONVERSATION_WINDOW_DAYS,
  BOOKING_SOURCE_METRIC_KEY,
  DASHBOARD_PERIOD,
  METRIC_KEY,
  dayRangeUtc,
  monthRangeUtc,
  round2,
} from './analytics.constants';

/** One UTC calendar day's appointment-volume bucket (T145, FR-A004). */
export interface AppointmentTrendDay {
  date: string;
  total: number;
  completed: number;
  cancelled: number;
  no_show: number;
}

/** One UTC calendar day's settled-revenue bucket (T145, FR-A003). */
export interface RevenueTrendDay {
  date: string;
  revenue: number;
}

/** T145, FR-A005/FR-A006 — cancellation/no-show/completion source counts. */
export interface RatesRaw {
  total: number;
  completed: number;
  cancelled: number;
  no_show: number;
  cancelledByPatient: number;
  cancelledByClinic: number;
}

/** T145, FR-A007/FR-A008 — retention + repeat-visit source counts. */
export interface RetentionRaw {
  retainedPatients: number;
  priorPeriodPatients: number;
  repeatDistribution: { visits: number; patients: number }[];
}

/** T145, FR-A009 — per-service source rows (unpaginated; caller pages). */
export interface ServicePerformanceRow {
  serviceId: string;
  name: string;
  appointments: number;
  revenue: number;
}

/** T145, FR-A011 — per-branch source rows (unpaginated; caller pages). */
export interface BranchPerformanceRow {
  branchId: string;
  name: string;
  appointments: number;
  revenue: number;
}

/** T145, FR-A012 — per-channel source rows (always all 4 `AppointmentSource`s). */
export interface ChannelPerformanceRow {
  source: AppointmentSource;
  appointments: number;
  completed: number;
  revenue: number;
}

export interface DailyMetrics {
  total_appointments: number;
  completed_appointments: number;
  cancelled_appointments: number;
  no_show_appointments: number;
  total_revenue: number;
  new_customers: number;
  ai_messages_count: number;
}

export interface StaffPerformanceRow {
  staffId: string;
  name: string;
  total_appointments: number;
  completed_appointments: number;
  cancelled_appointments: number;
  no_show_appointments: number;
  revenue: number;
  avg_rating: number | null;
}

export interface StaffPerformanceFilters {
  branchId?: string;
  /** Inclusive UTC day bounds ('YYYY-MM-DD'); default is the trailing 30 days. */
  from?: string;
  to?: string;
}

export interface DashboardKpi {
  metric_key: string;
  metric_value: number;
  period: string;
}

export interface TopService {
  serviceId: string;
  name: string;
  count: number;
  revenue: number;
}

export interface MonthlyExtras {
  avg_rating: number | null;
  top_services: TopService[];
}

/**
 * Analytics computation engine — the ONLY place heavy aggregation runs.
 *
 * Every query is tenant-scoped via relations; the tenant id always comes from
 * the caller (resolved from TenantContext upstream), never from input. Reads are
 * read-only against source domains; no source rows are mutated.
 *
 * STRICT scope separation between branch analytics and tenant analytics:
 *
 *  - BRANCH analytics (daily reports) contain ONLY metrics that are truly
 *    branch-scoped, each from a real relation — so two branches genuinely differ:
 *      • appointments (total/completed/cancelled), revenue — own branch FK.
 *      • ai_messages_count — AI messages whose conversation belongs to the branch
 *        (AiMessage → ai_conversations → conversations.branch). Messages with no
 *        branch are NOT branch-attributable and are excluded from branch reports
 *        (never duplicated or faked); they remain in the tenant total below.
 *      • avg_rating, top_services (monthly) — via appointment.branch.
 *    A metric that cannot be attributed to a branch is EXCLUDED from branch
 *    reports (e.g. new_customers — Customer has no branch relation — is reported
 *    as 0 at branch scope, not the tenant figure copied onto every branch).
 *
 *  - TENANT analytics (dashboard snapshot) own the tenant-wide figures and are
 *    the ONLY place they live: TOTAL_CUSTOMERS, AI_MESSAGES (all messages incl.
 *    branchless), AI_TOKENS_USED, etc. Nothing is removed — it just isn't smeared
 *    across branch rows.
 *
 * Tenant-level figures are never used for branch comparison and never replicated
 * across branches.
 */
@Injectable()
export class AnalyticsAggregationService {
  private readonly logger = new Logger('AnalyticsAggregationService');

  constructor(
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(AiMessage)
    private readonly aiMessages: Repository<AiMessage>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(CustomerReview)
    private readonly reviews: Repository<CustomerReview>,
    @InjectRepository(AppointmentServiceEntity)
    private readonly appointmentServices: Repository<AppointmentServiceEntity>,
    @InjectRepository(StaffProfile)
    private readonly staffProfiles: Repository<StaffProfile>,
    @InjectRepository(AppointmentCancellation)
    private readonly appointmentCancellations: Repository<AppointmentCancellation>,
  ) {}

  // ─────────────────────────────── Branches ──────────────────────────────── //

  async assertBranch(tenantId: string, branchId: string): Promise<Branch> {
    const branch = await this.branches.findOne({
      where: { id: branchId, tenant: { id: tenantId } },
    });
    if (!branch) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    }
    return branch;
  }

  async listActiveBranchIds(tenantId: string): Promise<string[]> {
    const branches = await this.branches.find({
      where: { tenant: { id: tenantId }, is_active: true },
      select: { id: true },
    });
    return branches.map((b) => b.id);
  }

  // ──────────────────────────── Daily aggregation ────────────────────────── //

  /**
   * The daily-report metrics for one branch/day — STRICTLY branch-scoped only:
   *  - appointment counts + revenue: the source row's own branch FK.
   *  - ai_messages_count: AI messages whose conversation belongs to this branch;
   *    branchless messages are excluded (counted only in the tenant dashboard).
   *  - new_customers: 0 — customer acquisition is NOT branch-attributable
   *    (Customer has no branch relation), so it is EXCLUDED from branch reports.
   *    The tenant-level customer figure lives on the dashboard (TOTAL_CUSTOMERS),
   *    never copied onto branch rows.
   */
  async computeDailyMetrics(
    tenantId: string,
    branchId: string,
    dateStr: string,
  ): Promise<DailyMetrics> {
    const { start, end } = dayRangeUtc(dateStr);

    const [appts, total_revenue, ai_messages_count] = await Promise.all([
      this.countBranchAppointments(tenantId, branchId, start, end),
      this.sumBranchRevenue(tenantId, branchId, start, end),
      this.countBranchAiMessages(tenantId, branchId, start, end),
    ]);

    return {
      total_appointments: appts.total,
      completed_appointments: appts.completed,
      cancelled_appointments: appts.cancelled,
      no_show_appointments: appts.no_show,
      total_revenue,
      // Excluded from branch scope (not branch-attributable). Tenant-level
      // customer counts are on the dashboard, never replicated across branches.
      new_customers: 0,
      ai_messages_count,
    };
  }

  // ────────────────────────── Dashboard KPIs ─────────────────────────────── //

  async computeDashboardKpis(tenantId: string): Promise<DashboardKpi[]> {
    const since = new Date(
      Date.now() - ACTIVE_CONVERSATION_WINDOW_DAYS * 86_400_000,
    );

    const [
      total_customers,
      total_appointments,
      total_paid_payments,
      active_conversations,
      ai_messages,
      total_revenue,
      ai_tokens_used,
      total_no_shows,
      bookingsBySource,
    ] = await Promise.all([
      this.customers.count({ where: { tenant: { id: tenantId } } }),
      this.appointments.count({ where: { tenant: { id: tenantId } } }),
      this.payments.count({
        where: { tenant: { id: tenantId }, status: PaymentStatus.PAID },
      }),
      this.conversations.count({
        where: {
          tenant: { id: tenantId },
          last_message_at: MoreThanOrEqual(since),
        },
      }),
      this.aiMessages.count({ where: { tenant: { id: tenantId } } }),
      this.sumTenantRevenue(tenantId),
      this.sumAiTokens(tenantId),
      this.appointments.count({
        where: { tenant: { id: tenantId }, status: AppointmentStatus.NO_SHOW },
      }),
      this.countTenantBookingsBySource(tenantId),
    ]);

    const kpi = (metric_key: string, metric_value: number): DashboardKpi => ({
      metric_key,
      metric_value,
      period: DASHBOARD_PERIOD,
    });

    return [
      kpi(METRIC_KEY.TOTAL_CUSTOMERS, total_customers),
      kpi(METRIC_KEY.TOTAL_APPOINTMENTS, total_appointments),
      kpi(METRIC_KEY.TOTAL_REVENUE, total_revenue),
      kpi(METRIC_KEY.TOTAL_PAID_PAYMENTS, total_paid_payments),
      kpi(METRIC_KEY.ACTIVE_CONVERSATIONS, active_conversations),
      kpi(METRIC_KEY.AI_MESSAGES, ai_messages),
      kpi(METRIC_KEY.AI_TOKENS_USED, ai_tokens_used),
      kpi(METRIC_KEY.TOTAL_NO_SHOWS, total_no_shows),
      ...bookingsBySource.map((row) => kpi(row.metric_key, row.count)),
    ];
  }

  /**
   * Tenant-wide appointment counts grouped by `Appointment.source`
   * (PLATFORM / WHATSAPP_BOT / MANUAL / PUBLIC_AI) — a single grouped query,
   * every enum value present in {@link BOOKING_SOURCE_METRIC_KEY} even when 0
   * (so the dashboard always shows all 4 channels, never omits a silent gap).
   */
  private async countTenantBookingsBySource(
    tenantId: string,
  ): Promise<{ metric_key: string; count: number }[]> {
    const rows = await this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .select('a.source', 'source')
      .addSelect('COUNT(*)', 'count')
      .where('t.id = :tenantId', { tenantId })
      .groupBy('a.source')
      .getRawMany<{ source: AppointmentSource; count: string }>();

    const counts = new Map(rows.map((r) => [r.source, Number(r.count)]));
    return Object.entries(BOOKING_SOURCE_METRIC_KEY).map(
      ([source, metric_key]) => ({
        metric_key,
        count: counts.get(source as AppointmentSource) ?? 0,
      }),
    );
  }

  // ───────────────────────── Monthly extras ──────────────────────────────── //

  async computeMonthlyExtras(
    tenantId: string,
    branchId: string,
    monthStr: string,
  ): Promise<MonthlyExtras> {
    const { start, end } = monthRangeUtc(monthStr);
    const [avg_rating, top_services] = await Promise.all([
      this.avgRating(tenantId, branchId, start, end),
      this.topServices(tenantId, branchId, start, end),
    ]);
    return { avg_rating, top_services };
  }

  /**
   * Monthly totals computed DIRECTLY FROM SOURCE (not summed from daily reports).
   *
   * Computing from source keeps the monthly snapshot internally consistent with
   * its source-derived extras (avg_rating / top_services) and immune to missing
   * or stale daily reports — a monthly regeneration no longer silently reads 0
   * because the dailies weren't (re)built first. Same UTC month window as the
   * extras, so every monthly field reflects the same instant.
   */
  async computeMonthlyTotals(
    tenantId: string,
    branchId: string,
    monthStr: string,
  ): Promise<{ total_appointments: number; total_revenue: number }> {
    const { start, end } = monthRangeUtc(monthStr);
    const [total_appointments, total_revenue] = await Promise.all([
      this.appointments.count({
        where: {
          tenant: { id: tenantId },
          branch: { id: branchId },
          start_at: Between(start, end),
        },
      }),
      this.sumBranchRevenue(tenantId, branchId, start, end),
    ]);
    return { total_appointments, total_revenue };
  }

  /**
   * Tenant-WIDE (every branch) totals for the CURRENT, in-progress UTC
   * calendar month — completed appointments (by `start_at`, same status
   * definition as every other "completed" figure in this file) and PAID
   * revenue (by `paid_at`). Backs the dashboard's appointment/revenue target
   * cards.
   *
   * Deliberately separate from {@link computeMonthlyTotals}: that method is
   * per-branch and meant for a CLOSED month's report, so a tenant-wide total
   * would mean summing across branches for every read. This is the one
   * tenant-wide, no-branch-filter equivalent for the month still in progress.
   */
  async computeCurrentMonthTenantTotals(
    tenantId: string,
    monthStr: string,
  ): Promise<{ completed_appointments: number; total_revenue: number }> {
    const { start, end } = monthRangeUtc(monthStr);
    const [completed_appointments, total_revenue] = await Promise.all([
      this.appointments.count({
        where: {
          tenant: { id: tenantId },
          status: AppointmentStatus.COMPLETED,
          start_at: Between(start, end),
        },
      }),
      this.sumTenantRevenue(tenantId, { start, end }),
    ]);
    return { completed_appointments, total_revenue };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /**
   * Total / completed / cancelled appointment counts for one branch/day in a
   * SINGLE round-trip via conditional aggregation (`COUNT(*) FILTER (WHERE …)`),
   * replacing the previous three separate `count()` queries.
   */
  private async countBranchAppointments(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
  ): Promise<{
    total: number;
    completed: number;
    cancelled: number;
    no_show: number;
  }> {
    const row = await this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .innerJoin('a.branch', 'b')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :completed)', 'completed')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :cancelled)', 'cancelled')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :noShow)', 'no_show')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('b.id = :branchId', { branchId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .setParameters({
        completed: AppointmentStatus.COMPLETED,
        cancelled: AppointmentStatus.CANCELLED,
        noShow: AppointmentStatus.NO_SHOW,
      })
      .getRawOne<{
        total: string;
        completed: string;
        cancelled: string;
        no_show: string;
      }>();

    return {
      total: Number(row?.total ?? 0),
      completed: Number(row?.completed ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      no_show: Number(row?.no_show ?? 0),
    };
  }

  private async sumBranchRevenue(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const row = await this.payments
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'sum')
      .innerJoin('p.tenant', 't')
      .innerJoin('p.branch', 'b')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('b.id = :branchId', { branchId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID })
      .andWhere('p.paid_at BETWEEN :start AND :end', { start, end })
      .getRawOne<{ sum: string }>();
    return round2(Number(row?.sum ?? 0));
  }

  /**
   * AI messages BRANCH-attributed for this branch/day, via the message's
   * conversation (AiMessage → ai_conversations → conversations.branch). Messages
   * whose conversation has no branch are not branch-attributable and are excluded
   * here — they are NOT dropped from analytics: the tenant dashboard's AI_MESSAGES
   * KPI still counts every message.
   *
   * NB: ai_messages.ai_conversation_id is a VARCHAR (not a uuid FK), so the join
   * to ai_conversations.id (uuid) is compared as text to avoid a type-mismatch.
   */
  private async countBranchAiMessages(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const row = await this.aiMessages
      .createQueryBuilder('m')
      .innerJoin('m.tenant', 't')
      .innerJoin('ai_conversations', 'ac', 'ac.id::text = m.ai_conversation_id')
      .innerJoin('conversations', 'c', 'c.id = ac."conversationId"')
      .select('COUNT(*)', 'count')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('c."branchId" = :branchId', { branchId })
      .andWhere('m.created_at BETWEEN :start AND :end', { start, end })
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0);
  }

  /**
   * Sum of PAID payments for a tenant, optionally restricted to a `paid_at`
   * window. Without `range`, this is the all-time dashboard KPI total; with
   * it, it's the same PAID-only revenue definition scoped to a period (used
   * by {@link computeCurrentMonthTenantTotals}) — one query, not a duplicate.
   */
  private async sumTenantRevenue(
    tenantId: string,
    range?: { start: Date; end: Date },
  ): Promise<number> {
    let qb = this.payments
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'sum')
      .innerJoin('p.tenant', 't')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID });
    if (range) {
      qb = qb.andWhere('p.paid_at BETWEEN :start AND :end', range);
    }
    const row = await qb.getRawOne<{ sum: string }>();
    return round2(Number(row?.sum ?? 0));
  }

  private async sumAiTokens(tenantId: string): Promise<number> {
    const row = await this.aiMessages
      .createQueryBuilder('m')
      .select('COALESCE(SUM(m.tokens_used), 0)', 'sum')
      .innerJoin('m.tenant', 't')
      .where('t.id = :tenantId', { tenantId })
      .getRawOne<{ sum: string }>();
    return Number(row?.sum ?? 0);
  }

  private async avgRating(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
  ): Promise<number | null> {
    const row = await this.reviews
      .createQueryBuilder('r')
      .select('AVG(r.rating)', 'avg')
      .addSelect('COUNT(*)', 'count')
      .innerJoin('r.tenant', 't')
      .innerJoin('r.appointment', 'a')
      .innerJoin('a.branch', 'b')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('b.id = :branchId', { branchId })
      .andWhere('r.created_at BETWEEN :start AND :end', { start, end })
      .getRawOne<{ avg: string; count: string }>();
    if (!row || Number(row.count) === 0) return null;
    return round2(Number(row.avg));
  }

  private async topServices(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
  ): Promise<TopService[]> {
    const rows = await this.appointmentServices
      .createQueryBuilder('aps')
      .innerJoin('aps.appointment', 'a')
      .innerJoin('aps.service', 's')
      .innerJoin('a.tenant', 't')
      .innerJoin('a.branch', 'b')
      .select('s.id', 'serviceId')
      .addSelect('s.name', 'name')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(aps.price), 0)', 'revenue')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('b.id = :branchId', { branchId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .groupBy('s.id')
      .addGroupBy('s.name')
      .orderBy('count', 'DESC')
      .limit(5)
      .getRawMany<{
        serviceId: string;
        name: string;
        count: string;
        revenue: string;
      }>();

    return rows.map((r) => ({
      serviceId: r.serviceId,
      name: r.name,
      count: Number(r.count),
      revenue: round2(Number(r.revenue)),
    }));
  }

  // ─────────────────────────── Staff performance ─────────────────────────── //

  /**
   * Fleet-wide, per-staff performance for a tenant over a window (default:
   * trailing 30 days). Tenant-scoped; optional branch/date filters. Only staff
   * with at least one appointment in the window appear (same convention as
   * `topServices` — nothing invented for staff with zero activity).
   *
   * Appointment counts, revenue, and rating are computed as THREE SEPARATE
   * grouped queries (not one join) — a staff member can have multiple
   * payments or reviews per appointment, and joining them onto the
   * appointment-count query would fan out and inflate the counts. Merged by
   * staffId in memory, same approach as `computeMonthlyExtras`.
   */
  async computeStaffPerformance(
    tenantId: string,
    filters: StaffPerformanceFilters,
  ): Promise<StaffPerformanceRow[]> {
    const start = filters.from
      ? dayRangeUtc(filters.from).start
      : new Date(Date.now() - 30 * 86_400_000);
    const end = filters.to ? dayRangeUtc(filters.to).end : new Date();

    const [counts, revenue, ratings] = await Promise.all([
      this.countStaffAppointments(tenantId, filters.branchId, start, end),
      this.sumStaffRevenue(tenantId, filters.branchId, start, end),
      this.avgStaffRating(tenantId, filters.branchId, start, end),
    ]);

    const revenueByStaff = new Map(revenue.map((r) => [r.staffId, r.revenue]));
    const ratingByStaff = new Map(
      ratings.map((r) => [r.staffId, r.avg_rating]),
    );

    return counts
      .map((row) => ({
        ...row,
        revenue: revenueByStaff.get(row.staffId) ?? 0,
        avg_rating: ratingByStaff.get(row.staffId) ?? null,
      }))
      .sort((a, b) => b.total_appointments - a.total_appointments);
  }

  private async countStaffAppointments(
    tenantId: string,
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<Omit<StaffPerformanceRow, 'revenue' | 'avg_rating'>[]> {
    let qb = this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .innerJoin('a.staff', 'staff')
      .innerJoin('staff.user', 'u')
      .select('staff.id', 'staffId')
      .addSelect('u.full_name', 'name')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :completed)', 'completed')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :cancelled)', 'cancelled')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :noShow)', 'no_show')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .setParameters({
        completed: AppointmentStatus.COMPLETED,
        cancelled: AppointmentStatus.CANCELLED,
        noShow: AppointmentStatus.NO_SHOW,
      })
      .groupBy('staff.id')
      .addGroupBy('u.full_name');

    if (branchId)
      qb = qb
        .innerJoin('a.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });

    const rows = await qb.getRawMany<{
      staffId: string;
      name: string;
      total: string;
      completed: string;
      cancelled: string;
      no_show: string;
    }>();

    return rows.map((r) => ({
      staffId: r.staffId,
      name: r.name,
      total_appointments: Number(r.total),
      completed_appointments: Number(r.completed),
      cancelled_appointments: Number(r.cancelled),
      no_show_appointments: Number(r.no_show),
    }));
  }

  private async sumStaffRevenue(
    tenantId: string,
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<{ staffId: string; revenue: number }[]> {
    let qb = this.payments
      .createQueryBuilder('p')
      .innerJoin('p.tenant', 't')
      .innerJoin('p.appointment', 'a')
      .innerJoin('a.staff', 'staff')
      .select('staff.id', 'staffId')
      .addSelect('COALESCE(SUM(p.amount), 0)', 'revenue')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID })
      .andWhere('p.paid_at BETWEEN :start AND :end', { start, end })
      .groupBy('staff.id');

    if (branchId) qb = qb.andWhere('a."branchId" = :branchId', { branchId });

    const rows = await qb.getRawMany<{ staffId: string; revenue: string }>();
    return rows.map((r) => ({
      staffId: r.staffId,
      revenue: round2(Number(r.revenue)),
    }));
  }

  private async avgStaffRating(
    tenantId: string,
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<{ staffId: string; avg_rating: number }[]> {
    let qb = this.reviews
      .createQueryBuilder('r')
      .innerJoin('r.tenant', 't')
      .innerJoin('r.appointment', 'a')
      .innerJoin('a.staff', 'staff')
      .select('staff.id', 'staffId')
      .addSelect('AVG(r.rating)', 'avg_rating')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('r.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('staff.id');

    if (branchId) qb = qb.andWhere('a."branchId" = :branchId', { branchId });

    const rows = await qb.getRawMany<{ staffId: string; avg_rating: string }>();
    return rows.map((r) => ({
      staffId: r.staffId,
      avg_rating: round2(Number(r.avg_rating)),
    }));
  }

  // ═══════════════ Advanced analytics (spec 014, US11, T145) ═══════════════ //
  //
  // Every method below is RANGE-scoped ([start, end) as real `Date` instants,
  // never a fixed row count) and OPTIONALLY branch-scoped — the two things
  // R13 found missing from the existing per-branch daily-report trend. Revenue
  // stays defined as settled (PAID) `Payment` rows exactly as `sumBranchRevenue`
  // above computes it; nothing here introduces a second revenue definition.

  /** FR-A004 — appointment-volume trend, one row per UTC day WITH data. */
  async appointmentsTrend(
    tenantId: string,
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<AppointmentTrendDay[]> {
    const dateExpr = `to_char(a.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    let qb = this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .select(dateExpr, 'date')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :completed)', 'completed')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :cancelled)', 'cancelled')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :noShow)', 'no_show')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .setParameters({
        completed: AppointmentStatus.COMPLETED,
        cancelled: AppointmentStatus.CANCELLED,
        noShow: AppointmentStatus.NO_SHOW,
      })
      .groupBy(dateExpr)
      .orderBy(dateExpr, 'ASC');

    if (branchId) {
      qb = qb
        .innerJoin('a.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });
    }

    const rows = await qb.getRawMany<{
      date: string;
      total: string;
      completed: string;
      cancelled: string;
      no_show: string;
    }>();
    return rows.map((r) => ({
      date: r.date,
      total: Number(r.total),
      completed: Number(r.completed),
      cancelled: Number(r.cancelled),
      no_show: Number(r.no_show),
    }));
  }

  /** FR-A003 — settled-revenue trend, one row per UTC day WITH data. */
  async revenueTrend(
    tenantId: string,
    branchId: string | undefined,
    currency: string,
    start: Date,
    end: Date,
  ): Promise<RevenueTrendDay[]> {
    const dateExpr = `to_char(p.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    let qb = this.payments
      .createQueryBuilder('p')
      .innerJoin('p.tenant', 't')
      .select(dateExpr, 'date')
      .addSelect('COALESCE(SUM(p.amount), 0)', 'revenue')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID })
      .andWhere('p.currency = :currency', { currency })
      .andWhere('p.paid_at BETWEEN :start AND :end', { start, end })
      .groupBy(dateExpr)
      .orderBy(dateExpr, 'ASC');

    if (branchId) {
      qb = qb
        .innerJoin('p.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });
    }

    const rows = await qb.getRawMany<{ date: string; revenue: string }>();
    return rows.map((r) => ({
      date: r.date,
      revenue: round2(Number(r.revenue)),
    }));
  }

  /**
   * FR-A021 — PAID payments in range whose currency does NOT match the
   * clinic's configured currency, so the caller can surface a mixed-currency
   * notice instead of silently summing across currencies.
   */
  async countOtherCurrencyRevenue(
    tenantId: string,
    branchId: string | undefined,
    currency: string,
    start: Date,
    end: Date,
  ): Promise<{ count: number; amount: number }> {
    let qb = this.payments
      .createQueryBuilder('p')
      .innerJoin('p.tenant', 't')
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(p.amount), 0)', 'amount')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID })
      .andWhere('p.currency != :currency', { currency })
      .andWhere('p.paid_at BETWEEN :start AND :end', { start, end });

    if (branchId) {
      qb = qb
        .innerJoin('p.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });
    }

    const row = await qb.getRawOne<{ count: string; amount: string }>();
    return {
      count: Number(row?.count ?? 0),
      amount: round2(Number(row?.amount ?? 0)),
    };
  }

  /**
   * FR-A005/FR-A006 — total/completed/cancelled/no-show counts for
   * appointments SCHEDULED TO OCCUR in the period (by `start_at`, any
   * status), plus the cancelled subset split by `AppointmentCancellation.origin`
   * (T019/T020) for the patient-vs-clinic breakdown.
   */
  async computeRates(
    tenantId: string,
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<RatesRaw> {
    let countsQb = this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :completed)', 'completed')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :cancelled)', 'cancelled')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :noShow)', 'no_show')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .setParameters({
        completed: AppointmentStatus.COMPLETED,
        cancelled: AppointmentStatus.CANCELLED,
        noShow: AppointmentStatus.NO_SHOW,
      });
    if (branchId) {
      countsQb = countsQb
        .innerJoin('a.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });
    }
    const counts = await countsQb.getRawOne<{
      total: string;
      completed: string;
      cancelled: string;
      no_show: string;
    }>();

    let originQb = this.appointmentCancellations
      .createQueryBuilder('c')
      .innerJoin('c.tenant', 't')
      .innerJoin('c.appointment', 'a')
      .select('c.origin', 'origin')
      .addSelect('COUNT(*)', 'count')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('a.status = :cancelled', {
        cancelled: AppointmentStatus.CANCELLED,
      })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .groupBy('c.origin');
    if (branchId) {
      originQb = originQb
        .innerJoin('a.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });
    }
    const originRows = await originQb.getRawMany<{
      origin: string;
      count: string;
    }>();
    const byOrigin = new Map(
      originRows.map((r) => [r.origin, Number(r.count)]),
    );

    return {
      total: Number(counts?.total ?? 0),
      completed: Number(counts?.completed ?? 0),
      cancelled: Number(counts?.cancelled ?? 0),
      no_show: Number(counts?.no_show ?? 0),
      cancelledByPatient: byOrigin.get(AppointmentActionOrigin.PATIENT) ?? 0,
      cancelledByClinic: byOrigin.get(AppointmentActionOrigin.STAFF) ?? 0,
    };
  }

  /**
   * FR-A007/FR-A008 — retention + repeat-visit distribution, computed
   * entirely in Postgres via `EXISTS`/`GROUP BY` rather than pulling patient
   * id lists into application memory (which would not scale to a clinic with
   * a large patient base).
   */
  async computeRetention(
    tenantId: string,
    branchId: string | undefined,
    priorStart: Date,
    priorEnd: Date,
    chosenStart: Date,
    chosenEnd: Date,
  ): Promise<RetentionRaw> {
    const branchRetentionClause = branchId ? 'AND a."branchId" = $7' : '';
    const branchRetentionExistsClause = branchId
      ? 'AND a2."branchId" = $7'
      : '';
    const retentionParams: unknown[] = [
      tenantId,
      AppointmentStatus.COMPLETED,
      priorStart,
      priorEnd,
      chosenStart,
      chosenEnd,
      ...(branchId ? [branchId] : []),
    ];
    const [retentionRow] = await this.appointments.manager.query<
      { prior_count: number; retained_count: number }[]
    >(
      `WITH prior AS (
         SELECT DISTINCT a."customerId" AS cid
         FROM appointments a
         WHERE a."tenantId" = $1 AND a.status = $2 AND a.start_at BETWEEN $3 AND $4
         ${branchRetentionClause}
       )
       SELECT
         (SELECT COUNT(*) FROM prior)::int AS prior_count,
         (SELECT COUNT(*) FROM prior p WHERE EXISTS (
            SELECT 1 FROM appointments a2
            WHERE a2."tenantId" = $1 AND a2.status = $2 AND a2."customerId" = p.cid
              AND a2.start_at BETWEEN $5 AND $6
              ${branchRetentionExistsClause}
         ))::int AS retained_count`,
      retentionParams,
    );

    const branchDistClause = branchId ? 'AND a."branchId" = $5' : '';
    const distParams: unknown[] = [
      tenantId,
      AppointmentStatus.COMPLETED,
      chosenStart,
      chosenEnd,
      ...(branchId ? [branchId] : []),
    ];
    const distRows = await this.appointments.manager.query<
      { visits: string; patients: string }[]
    >(
      `SELECT visits, COUNT(*)::int AS patients FROM (
         SELECT a."customerId" AS cid, COUNT(*) AS visits
         FROM appointments a
         WHERE a."tenantId" = $1 AND a.status = $2 AND a.start_at BETWEEN $3 AND $4
         ${branchDistClause}
         GROUP BY a."customerId"
       ) t
       GROUP BY visits`,
      distParams,
    );

    let one = 0;
    let two = 0;
    let threeOrMore = 0;
    for (const r of distRows) {
      const visits = Number(r.visits);
      const patients = Number(r.patients);
      if (visits === 1) one += patients;
      else if (visits === 2) two += patients;
      else threeOrMore += patients;
    }

    return {
      retainedPatients: Number(retentionRow?.retained_count ?? 0),
      priorPeriodPatients: Number(retentionRow?.prior_count ?? 0),
      repeatDistribution: [
        { visits: 1, patients: one },
        { visits: 2, patients: two },
        { visits: 3, patients: threeOrMore }, // "3 or more" bucket
      ],
    };
  }

  /** FR-A009 — per-service booking count + booked line-item price, unpaged. */
  async servicePerformance(
    tenantId: string,
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<ServicePerformanceRow[]> {
    let qb = this.appointmentServices
      .createQueryBuilder('aps')
      .innerJoin('aps.appointment', 'a')
      .innerJoin('aps.service', 's')
      .innerJoin('a.tenant', 't')
      .select('s.id', 'serviceId')
      .addSelect('s.name', 'name')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(aps.price), 0)', 'revenue')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .groupBy('s.id')
      .addGroupBy('s.name')
      .orderBy('count', 'DESC');

    if (branchId) {
      qb = qb
        .innerJoin('a.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });
    }

    const rows = await qb.getRawMany<{
      serviceId: string;
      name: string;
      count: string;
      revenue: string;
    }>();
    return rows.map((r) => ({
      serviceId: r.serviceId,
      name: r.name,
      appointments: Number(r.count),
      revenue: round2(Number(r.revenue)),
    }));
  }

  /**
   * FR-A011 — per-branch appointment count + settled revenue, unpaged, one
   * row for EVERY branch in scope (even zero-activity ones — a branch never
   * silently disappears from the comparison).
   */
  async branchPerformance(
    tenantId: string,
    branchIds: string[] | undefined,
    start: Date,
    end: Date,
  ): Promise<BranchPerformanceRow[]> {
    let allBranchesQb = this.branches
      .createQueryBuilder('b')
      .innerJoin('b.tenant', 't')
      .select('b.id', 'branchId')
      .addSelect('b.name', 'name')
      .where('t.id = :tenantId', { tenantId })
      .orderBy('b.name', 'ASC');
    if (branchIds?.length) {
      allBranchesQb = allBranchesQb.andWhere('b.id IN (:...branchIds)', {
        branchIds,
      });
    }
    const allBranches = await allBranchesQb.getRawMany<{
      branchId: string;
      name: string;
    }>();

    let apptQb = this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .innerJoin('a.branch', 'b')
      .select('b.id', 'branchId')
      .addSelect('COUNT(*)', 'count')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .groupBy('b.id');
    if (branchIds?.length) {
      apptQb = apptQb.andWhere('b.id IN (:...branchIds)', { branchIds });
    }
    const apptRows = await apptQb.getRawMany<{
      branchId: string;
      count: string;
    }>();
    const apptByBranch = new Map(
      apptRows.map((r) => [r.branchId, Number(r.count)]),
    );

    let payQb = this.payments
      .createQueryBuilder('p')
      .innerJoin('p.tenant', 't')
      .innerJoin('p.branch', 'b')
      .select('b.id', 'branchId')
      .addSelect('COALESCE(SUM(p.amount), 0)', 'revenue')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID })
      .andWhere('p.paid_at BETWEEN :start AND :end', { start, end })
      .groupBy('b.id');
    if (branchIds?.length) {
      payQb = payQb.andWhere('b.id IN (:...branchIds)', { branchIds });
    }
    const payRows = await payQb.getRawMany<{
      branchId: string;
      revenue: string;
    }>();
    const revenueByBranch = new Map(
      payRows.map((r) => [r.branchId, round2(Number(r.revenue))]),
    );

    return allBranches.map((b) => ({
      branchId: b.branchId,
      name: b.name,
      appointments: apptByBranch.get(b.branchId) ?? 0,
      revenue: revenueByBranch.get(b.branchId) ?? 0,
    }));
  }

  /**
   * FR-A012 — per-`AppointmentSource` appointment/completed counts + settled
   * revenue. Always returns all 4 sources, even at zero, matching the
   * dashboard's own booking-by-source convention (never a silent gap).
   */
  async channelPerformance(
    tenantId: string,
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<ChannelPerformanceRow[]> {
    let apptQb = this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .select('a.source', 'source')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE a.status = :completed)', 'completed')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .setParameters({ completed: AppointmentStatus.COMPLETED })
      .groupBy('a.source');
    if (branchId) {
      apptQb = apptQb
        .innerJoin('a.branch', 'b')
        .andWhere('b.id = :branchId', { branchId });
    }
    const apptRows = await apptQb.getRawMany<{
      source: AppointmentSource;
      total: string;
      completed: string;
    }>();
    const apptBySource = new Map(
      apptRows.map((r) => [
        r.source,
        { total: Number(r.total), completed: Number(r.completed) },
      ]),
    );

    let payQb = this.payments
      .createQueryBuilder('p')
      .innerJoin('p.tenant', 't')
      .innerJoin('p.appointment', 'a')
      .select('a.source', 'source')
      .addSelect('COALESCE(SUM(p.amount), 0)', 'revenue')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID })
      .andWhere('p.paid_at BETWEEN :start AND :end', { start, end })
      .groupBy('a.source');
    if (branchId) {
      payQb = payQb.andWhere('a."branchId" = :branchId', { branchId });
    }
    const payRows = await payQb.getRawMany<{
      source: AppointmentSource;
      revenue: string;
    }>();
    const revenueBySource = new Map(
      payRows.map((r) => [r.source, round2(Number(r.revenue))]),
    );

    return Object.values(AppointmentSource).map((source) => ({
      source,
      appointments: apptBySource.get(source)?.total ?? 0,
      completed: apptBySource.get(source)?.completed ?? 0,
      revenue: revenueBySource.get(source) ?? 0,
    }));
  }
}
