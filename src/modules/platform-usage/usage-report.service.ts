import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { UsageReportSchedule } from '../../entities/System/UsageReportSchedule';
import { EmailService } from '../email/email.service';
import { QueueService } from '../../queue/queue.service';
import { assertSafeWebhookUrl } from '../platform/webhook-url-guard';
import { deliverWebhookRequest } from '../platform/webhook-http-client';
import { PlatformUsageService } from './platform-usage.service';
import {
  CreateUsageReportScheduleDto,
  UpdateUsageReportScheduleDto,
} from './dto/usage-report-schedule.dto';

/**
 * Rolling window for `claimRun`'s concurrent-race guard (gap-closure pass —
 * see docs/CACHING_QUEUES_AUDIT.md §0.8.6). Only needs to be larger than the
 * real timing skew between a tick firing and a manual "Run now" click landing
 * at nearly the same instant — a few seconds is generous margin for that,
 * while staying far too short to ever delay a human-paced retry.
 */
const USAGE_REPORT_CLAIM_WINDOW_MS = 5_000;

/** Upper bound on one webhook POST, so a hung receiver cannot pin a worker slot. */
const USAGE_REPORT_WEBHOOK_TIMEOUT_MS = 10_000;

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
    if (dto.delivery === 'WEBHOOK') assertSafeWebhookUrl(dto.target);
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
    if (schedule.delivery === 'WEBHOOK') assertSafeWebhookUrl(schedule.target);
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
  /**
   * Runs a schedule now. Called from TWO places: the tick-driven `usageReport.run`
   * queue job (fires when due) AND the super-admin "run now" HTTP endpoint,
   * which previously called this DIRECTLY — bypassing the queue and its jobId
   * entirely (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.11). A
   * manual click racing the tick for the same schedule could double-send the
   * report with NO protection at all. Fixed with a minute-bucketed atomic
   * claim on `last_run_at` — reusing the existing column rather than adding a
   * new one — INSIDE this shared method, so both callers are covered without
   * changing either one's contract (the HTTP endpoint still returns real
   * delivery status synchronously).
   *
   * RECIPIENT-LEVEL IDEMPOTENCY WITHIN THE RUN (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.11): `deliver()` persists
   * `last_run_recipient_status` incrementally (one DB write per recipient
   * sent, not one write at the very end) — see its own docstring for why a
   * single end-of-run write cannot survive a hard process crash mid-loop. On
   * FULL success the map is reset to `{}` here, ready for the next due cycle;
   * on any failure it is left exactly as `deliver()` last wrote it, so the
   * NEXT `runSchedule` retry (whether via the claim's FAILED-bypass or the
   * short-window bypass) skips every recipient already marked SENT instead of
   * resubmitting to them.
   */
  async runSchedule(id: string): Promise<{ id: string; status: string }> {
    const schedule = await this.findOne(id);
    const claimedAt = new Date();
    if (!(await this.claimRun(id, claimedAt))) {
      return { id, status: 'SKIPPED: already run very recently (concurrent tick/manual-run race)' };
    }
    let status = 'SENT';
    try {
      const report = await this.buildReport(schedule);
      await this.deliver(id, schedule, report, claimedAt);
      // Full success — every recipient (or the single webhook target)
      // delivered. Reset so the NEXT due cycle starts with a clean slate.
      await this.schedules.update(id, { last_run_recipient_status: {} });
    } catch (err) {
      status = `FAILED: ${(err as Error)?.message}`.slice(0, 240);
      this.logger.warn(`Report ${id} delivery failed: ${(err as Error)?.message}`);
    }
    await this.schedules.update(id, { last_run_at: claimedAt, last_status: status });
    return { id, status };
  }

  /**
   * Atomic claim (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md
   * §0.8.6). `last_run_at` is overloaded as both the claim marker AND the
   * "when did this last actually run" bookkeeping field — a deliberate
   * minimal trade-off (no new column/migration) rather than a design that
   * pretends they're unrelated.
   *
   * TWO cases must both hold, and the original minute-aligned-bucket version
   * only got the first one right:
   *  - A tick and a simultaneous manual "Run now" click must not BOTH run —
   *    guarded by the short `CLAIM_WINDOW_MS` rolling window (large enough to
   *    absorb real concurrent-call timing skew, far too short to ever delay a
   *    human-paced retry).
   *  - A manual retry after a FAILURE must NEVER be blocked, no matter how
   *    soon after the failure it happens — `last_status LIKE 'FAILED%'`
   *    bypasses the window entirely. The previous version re-stamped
   *    `last_run_at` to "now" even on failure and gated purely on wall-clock
   *    MINUTE alignment, so a failure recorded at, say, :00:58 blocked a
   *    retry attempted at :00:59 for a full extra minute — exactly the
   *    "can't retry after a failure" bug this closes.
   */
  private async claimRun(id: string, at: Date): Promise<boolean> {
    const shortCutoff = new Date(at.getTime() - USAGE_REPORT_CLAIM_WINDOW_MS);
    const result = await this.schedules
      .createQueryBuilder()
      .update(UsageReportSchedule)
      .set({ last_run_at: at })
      .where(
        `id = :id AND (last_run_at IS NULL OR last_status LIKE 'FAILED%' OR last_run_at < :shortCutoff)`,
        { id, shortCutoff },
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * WEBHOOK: unchanged — a single target, one atomic call, already fully
   * covered by `runSchedule`'s schedule-level claim (no per-recipient
   * concept applies to one URL).
   *
   * EMAIL: `target` may be a COMMA-SEPARATED list (fully backward compatible
   * — a single address parses to a one-element list, identical to before).
   * Each recipient not already marked SENT in `schedule.last_run_recipient_status`
   * (carried over from a prior FAILED/interrupted attempt at THIS due cycle)
   * is sent to, and the status map is persisted to the DATABASE immediately
   * after EACH send succeeds — deliberately NOT batched into one write at the
   * end. A hard process crash (OS kill) between recipient #1 and #2 runs no
   * further JS at all, so only an already-durable per-recipient write (not an
   * in-memory accumulator flushed later) can make the NEXT attempt aware that
   * recipient #1 must not be re-sent to.
   */
  private async deliver(
    scheduleId: string,
    schedule: UsageReportSchedule,
    report: Record<string, unknown>,
    claimedAt: Date,
  ): Promise<void> {
    if (schedule.delivery === 'WEBHOOK') {
      // SSRF-guarded, DNS-pinned, redirect-free and time-bounded — the same path every
      // other outbound webhook uses. The target is re-validated on every run, so a
      // schedule saved before this guard existed is still refused.
      const res = await deliverWebhookRequest(
        schedule.target,
        JSON.stringify({ type: 'usage_report', report }),
        { 'content-type': 'application/json' },
        USAGE_REPORT_WEBHOOK_TIMEOUT_MS,
      );
      if (!res.ok) {
        throw new Error(
          res.httpStatus ? `Webhook returned ${res.httpStatus}` : (res.error ?? 'Webhook delivery failed'),
        );
      }
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

    const recipients = schedule.target
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const sentStatus: Record<string, string> = { ...(schedule.last_run_recipient_status ?? {}) };

    for (const recipient of recipients) {
      if (sentStatus[recipient] === 'SENT') continue; // already delivered earlier in THIS due cycle
      await this.email.sendDoctorNotification({
        to: recipient,
        title: `Platform Usage Report — ${schedule.name}`,
        message: `${schedule.frequency} usage report (${report.periodMonth}). ${digest}`,
        // BUSINESS-PROCESS key (gap-closure pass — see
        // docs/CACHING_QUEUES_AUDIT.md §0.8.4), now per-recipient too: keyed
        // on THIS claimed run of THIS schedule for THIS recipient, not on the
        // rendered digest text. Two genuinely different periods whose totals
        // happen to render identically (e.g. a quiet tenant, zero activity
        // two months running) must both send — a content hash would wrongly
        // collapse them into one.
        idempotencyKey: `usage-report:${scheduleId}:${claimedAt.toISOString()}:${recipient}`,
      });
      sentStatus[recipient] = 'SENT';
      await this.schedules.update(scheduleId, { last_run_recipient_status: { ...sentStatus } });
    }
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
