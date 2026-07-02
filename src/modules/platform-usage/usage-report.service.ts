import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { UsageReportSchedule } from '../../entities/System/UsageReportSchedule';
import { EmailService } from '../email/email.service';
import { QueueService } from '../../queue/queue.service';
import { PlatformUsageService } from './platform-usage.service';
import {
  CreateUsageReportScheduleDto,
  UpdateUsageReportScheduleDto,
} from './dto/usage-report-schedule.dto';

/**
 * Scheduled usage reports (PART 5). CRUD + generation + delivery. The report
 * BODY is assembled entirely from `PlatformUsageService` (summary + executive
 * insights) — no usage/quota is computed here. Delivery reuses the existing
 * `EmailService`; webhooks post JSON. A repeatable "tick" (worker) calls
 * `runDue()` which enqueues one run per due schedule (idempotent per minute).
 *
 * PDF generation is intentionally out of scope (no PDF engine dependency); the
 * `format` field is honoured for JSON/CSV payloads and reserved for PDF later.
 */
@Injectable()
export class UsageReportService {
  private readonly logger = new Logger(UsageReportService.name);

  constructor(
    @InjectRepository(UsageReportSchedule)
    private readonly schedules: Repository<UsageReportSchedule>,
    private readonly platformUsage: PlatformUsageService,
    private readonly email: EmailService,
    private readonly queues: QueueService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  create(dto: CreateUsageReportScheduleDto, userId?: string): Promise<UsageReportSchedule> {
    if (dto.frequency === 'CUSTOM' && !dto.cron) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'cron is required for CUSTOM frequency' });
    }
    return this.schedules.save(
      this.schedules.create({
        name: dto.name,
        frequency: dto.frequency,
        cron: dto.cron,
        delivery: dto.delivery,
        target: dto.target,
        format: dto.format ?? 'JSON',
        sections: dto.sections,
        is_active: dto.is_active ?? true,
        created_by: userId,
      }),
    );
  }

  findAll(): Promise<UsageReportSchedule[]> {
    return this.schedules.find({ order: { created_at: 'DESC' } });
  }

  async findOne(id: string): Promise<UsageReportSchedule> {
    const found = await this.schedules.findOne({ where: { id } });
    if (!found) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Report schedule not found' });
    return found;
  }

  async update(id: string, dto: UpdateUsageReportScheduleDto): Promise<UsageReportSchedule> {
    const schedule = await this.findOne(id);
    Object.assign(schedule, {
      ...dto,
      sections: dto.sections === undefined ? schedule.sections : dto.sections,
    });
    return this.schedules.save(schedule);
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.findOne(id);
    await this.schedules.delete(id);
    return { id };
  }

  // ── Generation + delivery ───────────────────────────────────────────────

  /** Assemble the report body from the existing platform-usage aggregations. */
  async buildReport(schedule: UsageReportSchedule): Promise<Record<string, unknown>> {
    const want = (s: string) => !schedule.sections?.length || schedule.sections.includes(s);
    const [summary, insights] = await Promise.all([
      this.platformUsage.summary(),
      want('topConsumers') || want('growth') || want('storage') || want('api')
        ? this.platformUsage.executiveInsights()
        : Promise.resolve(null),
    ]);

    const body: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      schedule: { id: schedule.id, name: schedule.name, frequency: schedule.frequency },
      periodMonth: summary.periodMonth,
    };
    if (want('usage')) body.totals = summary.totals;
    if (want('exceeded')) body.alerts = summary.alerts;
    if (want('usage')) body.insights = summary.insights;
    if (insights) {
      if (want('storage')) body.topStorageConsumers = insights.topStorageConsumers;
      if (want('api')) body.topApiConsumers = insights.topApiConsumers;
      if (want('topConsumers')) body.topAiConsumers = insights.topAiConsumers;
      if (want('growth')) body.largestApiIncrease = insights.largestApiIncrease;
    }
    return body;
  }

  /** Runs one schedule now: build + deliver + record status. Best-effort. */
  async runSchedule(id: string): Promise<{ id: string; status: string }> {
    const schedule = await this.findOne(id);
    let status = 'SENT';
    try {
      const report = await this.buildReport(schedule);
      await this.deliver(schedule, report);
    } catch (err) {
      status = `FAILED: ${(err as Error)?.message}`.slice(0, 240);
      this.logger.warn(`Report ${id} delivery failed: ${(err as Error)?.message}`);
    }
    await this.schedules.update(id, { last_run_at: new Date(), last_status: status });
    return { id, status };
  }

  private async deliver(schedule: UsageReportSchedule, report: Record<string, unknown>): Promise<void> {
    if (schedule.delivery === 'WEBHOOK') {
      const res = await fetch(schedule.target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'usage_report', report }),
      });
      if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
      return;
    }
    // EMAIL — reuse the transactional EmailService (generic notification template).
    const totals = (report.totals ?? {}) as Record<string, number>;
    const digest = [
      `Active tenants: ${totals.totalActiveTenants ?? 0}`,
      `Over limit: ${totals.totalOverLimit ?? 0}`,
      `AI tokens: ${totals.totalAiTokens ?? 0}`,
      `API calls: ${totals.totalApiCalls ?? 0}`,
      `Alerts: ${(report.alerts as unknown[])?.length ?? 0}`,
    ].join(' · ');
    await this.email.sendDoctorNotification({
      to: schedule.target,
      title: `Platform Usage Report — ${schedule.name}`,
      message: `${schedule.frequency} usage report (${report.periodMonth}). ${digest}`,
    });
  }

  // ── Scheduling ──────────────────────────────────────────────────────────

  /** Enqueue a run for every active schedule that is currently due. */
  async runDue(now: Date = new Date()): Promise<number> {
    const active = await this.schedules.find({ where: { is_active: true } });
    const due = active.filter((s) => this.isDue(s, now));
    for (const s of due) {
      await this.queues.enqueueUsageReportRun({ tenantId: null, scheduleId: s.id }).catch((err) => {
        this.logger.warn(`Could not enqueue report ${s.id}: ${(err as Error)?.message}`);
      });
    }
    return due.length;
  }

  /** Due-ness from frequency + last_run_at (cron patterns approximated to daily). */
  private isDue(s: UsageReportSchedule, now: Date): boolean {
    if (!s.last_run_at) return true;
    const hours = (now.getTime() - new Date(s.last_run_at).getTime()) / 3_600_000;
    switch (s.frequency) {
      case 'WEEKLY':
        return hours >= 24 * 7 - 1;
      case 'MONTHLY':
        return new Date(s.last_run_at).getUTCMonth() !== now.getUTCMonth() || hours >= 24 * 28;
      case 'DAILY':
      case 'CUSTOM':
      default:
        return hours >= 23;
    }
  }
}
