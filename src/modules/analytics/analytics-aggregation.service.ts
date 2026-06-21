import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, MoreThanOrEqual, Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { Payment } from '../../entities/Payments/Payment';
import { Customer } from '../../entities/CRM/Customer';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Conversation } from '../../entities/Conversations/Conversation';
import { CustomerReview } from '../../entities/CRM/CustomerReview';
import { AppointmentStatus, PaymentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import {
  ACTIVE_CONVERSATION_WINDOW_DAYS,
  DASHBOARD_PERIOD,
  METRIC_KEY,
  dayRangeUtc,
  monthRangeUtc,
  round2,
} from './analytics.constants';

export interface DailyMetrics {
  total_appointments: number;
  completed_appointments: number;
  cancelled_appointments: number;
  total_revenue: number;
  new_customers: number;
  ai_messages_count: number;
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
    ] = await Promise.all([
      this.customers.count({ where: { tenant: { id: tenantId } } }),
      this.appointments.count({ where: { tenant: { id: tenantId } } }),
      this.payments.count({
        where: { tenant: { id: tenantId }, status: PaymentStatus.PAID },
      }),
      this.conversations.count({
        where: { tenant: { id: tenantId }, last_message_at: MoreThanOrEqual(since) },
      }),
      this.aiMessages.count({ where: { tenant: { id: tenantId } } }),
      this.sumTenantRevenue(tenantId),
      this.sumAiTokens(tenantId),
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
    ];
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
  ): Promise<{ total: number; completed: number; cancelled: number }> {
    const row = await this.appointments
      .createQueryBuilder('a')
      .innerJoin('a.tenant', 't')
      .innerJoin('a.branch', 'b')
      .select('COUNT(*)', 'total')
      .addSelect(
        'COUNT(*) FILTER (WHERE a.status = :completed)',
        'completed',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE a.status = :cancelled)',
        'cancelled',
      )
      .where('t.id = :tenantId', { tenantId })
      .andWhere('b.id = :branchId', { branchId })
      .andWhere('a.start_at BETWEEN :start AND :end', { start, end })
      .setParameters({
        completed: AppointmentStatus.COMPLETED,
        cancelled: AppointmentStatus.CANCELLED,
      })
      .getRawOne<{ total: string; completed: string; cancelled: string }>();

    return {
      total: Number(row?.total ?? 0),
      completed: Number(row?.completed ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
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

  private async sumTenantRevenue(tenantId: string): Promise<number> {
    const row = await this.payments
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'sum')
      .innerJoin('p.tenant', 't')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('p.status = :status', { status: PaymentStatus.PAID })
      .getRawOne<{ sum: string }>();
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
      .getRawMany<{ serviceId: string; name: string; count: string; revenue: string }>();

    return rows.map((r) => ({
      serviceId: r.serviceId,
      name: r.name,
      count: Number(r.count),
      revenue: round2(Number(r.revenue)),
    }));
  }
}
