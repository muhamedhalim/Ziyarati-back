import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';

import { ILike } from 'typeorm';

import { EmailLog } from '../../entities/System/EmailLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { EmailSendJob } from '../../queue/job-data.interface';
import { EmailProviderFactory } from './providers/email-provider.factory';
import { EMAIL_BRAND_NAME, resolveEmailConfig } from './email.config';
import { renderEmail } from './email.templates';
import { scrubFailureReason } from '../../common/utils/log-scrubber.util';

/** Keys stripped from stored metadata (never persist tokens/links/PII). */
const SENSITIVE = /token|url|password|secret|code|otp/i;

/**
 * Renders a template, sends it through the active provider, and records the
 * attempt in `email_logs`. Callable directly (sync mode) or by the worker's
 * EmailProcessor. Transient failures re-throw so BullMQ retries with backoff;
 * permanent ones throw {@link UnrecoverableError} so the job lands in FAILED
 * with no further attempts. Returning normally on a permanent failure (the
 * previous behaviour) marked the job COMPLETED — a misconfigured sender then
 * failed every email while the queue reported 100% success.
 *
 * IDEMPOTENCY (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.11 /
 * original audit H5): the PREVIOUS version checked-then-acted (`findOne`, then
 * compare `status`) — a race window between two concurrent deliveries of the
 * same key (a redelivered BullMQ job, or a duplicate `@OnEvent` fan-out) could
 * both pass the check and both send. This version uses `email_logs`' existing
 * UNIQUE `idempotency_key` index as an ATOMIC claim: `INSERT ... ON CONFLICT
 * (idempotency_key) DO NOTHING RETURNING id`. Winning the insert means this
 * call owns the send; losing it means a row already exists — `FOR UPDATE` on
 * that row then decides SKIP (already SENT) vs RETRY (was FAILED/QUEUED, e.g.
 * a prior attempt crashed mid-send) without a second race window, since the
 * row is locked for the rest of the transaction either way.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(
    @InjectRepository(EmailLog)
    private readonly logs: Repository<EmailLog>,
    private readonly factory: EmailProviderFactory,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async deliver(job: EmailSendJob): Promise<void> {
    if (!job.idempotencyKey) {
      // No key at all — a caller outside EmailService.send (which now always
      // supplies one, see that service). No claim is possible without a key;
      // send best-effort and log, same as the pre-fix behaviour for this edge.
      return this.sendAndRecord(job, null);
    }

    const claim = await this.claim(job.idempotencyKey);
    if (claim === 'ALREADY_SENT') {
      this.logger.log(`Skipping duplicate email (${job.idempotencyKey}) — already SENT`);
      return;
    }
    // 'CLAIMED': either a brand-new row (this call is first) or a legitimate
    // retry of a row left QUEUED/FAILED by a prior attempt.
    await this.sendAndRecord(job, job.idempotencyKey);
  }

  /** Atomic claim via the UNIQUE idempotency_key index. Never races: the losing side locks the same row before deciding. */
  private async claim(key: string): Promise<'CLAIMED' | 'ALREADY_SENT'> {
    return this.dataSource.transaction(async (m) => {
      const inserted = await m.query(
        `INSERT INTO email_logs (idempotency_key, to_address, template, status)
         VALUES ($1, '', '', 'QUEUED') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [key],
      );
      if (inserted[0]?.id) return 'CLAIMED';

      const [row] = await m.query(
        `SELECT status FROM email_logs WHERE idempotency_key = $1 FOR UPDATE`,
        [key],
      );
      if (row?.status === 'SENT') return 'ALREADY_SENT';
      return 'CLAIMED'; // QUEUED or FAILED — retry
    });
  }

  private async sendAndRecord(job: EmailSendJob, claimedKey: string | null): Promise<void> {
    const cfg = resolveEmailConfig(this.config);
    const ctx = {
      appUrl: cfg.appUrl,
      locale: job.locale ?? cfg.defaultLocale,
      brand: EMAIL_BRAND_NAME,
      // Appointment notices are minimal unless the platform opts in (residency plan P8).
      includeHealthDetail:
        String(this.config.get('EMAIL_INCLUDE_HEALTH_DETAIL', 'false')) === 'true',
    };
    const rendered = renderEmail(job.template, job.variables ?? {}, ctx);
    const provider = this.factory.resolve();
    const toAddr = Array.isArray(job.to) ? job.to[0] : job.to;

    const result = await provider.send({
      to: job.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: cfg.from,
      replyTo: job.replyTo ?? cfg.replyTo,
      tags: [{ name: 'template', value: job.template }],
      idempotencyKey: claimedKey ?? undefined,
    });

    await this.record(job, rendered.subject, provider.name, ctx.locale, toAddr, result, claimedKey);

    if (!result.success) {
      // A provider error can echo the recipient address; this reason ends up in
      // BullMQ's failedReason (Redis) and the logs, so it is scrubbed first.
      const reason = scrubFailureReason(result.error ?? 'unknown provider error', 300);
      if (result.transient) {
        // Re-throw so BullMQ retries with the configured backoff.
        throw new Error(scrubFailureReason(result.error ?? 'Transient email delivery failure'));
      }
      // Permanent (bad sender/recipient/credentials): retrying cannot succeed.
      throw new UnrecoverableError(
        `Permanent email delivery failure (template=${job.template}, provider=${provider.name}): ${reason}`,
      );
    }
  }

  private async record(
    job: EmailSendJob,
    subject: string,
    provider: string,
    locale: string,
    toAddr: string,
    result: { success: boolean; providerMessageId?: string; error?: string },
    claimedKey: string | null,
  ): Promise<void> {
    try {
      // The claim (if any) already created/located the row via `idempotency_key`.
      let log = claimedKey
        ? await this.logs.findOne({ where: { idempotency_key: claimedKey } })
        : null;
      if (!log) {
        log = this.logs.create({
          idempotency_key: job.idempotencyKey,
          to_address: toAddr,
          // P0.7: tenant_id is now the join column of a relation (see
          // EmailLog.ts), not a plain scalar.
          tenant: job.tenantId ? ({ id: job.tenantId } as Tenant) : undefined,
        });
      }
      log.to_address = toAddr;
      if (job.tenantId) log.tenant = { id: job.tenantId } as Tenant;
      log.template = job.template;
      log.subject = subject;
      log.locale = locale;
      log.provider = provider;
      log.attempts = (log.attempts ?? 0) + 1;
      log.metadata = this.safeMeta(job.variables);
      if (result.success) {
        log.status = 'SENT';
        log.provider_message_id = result.providerMessageId;
        log.error = undefined;
        log.sent_at = new Date();
      } else {
        log.status = 'FAILED';
        log.error = result.error ? scrubFailureReason(result.error, 1000) : undefined;
      }
      await this.logs.save(log);
    } catch (err) {
      // Logging failure must never break delivery.
      this.logger.warn(`email_log write failed: ${(err as Error)?.message}`);
    }
  }

  // ── Read side (observability) ────────────────────────────────────────────

  /**
   * Latest delivery outcome per recipient for one template — batched (one
   * query for N addresses, not N queries). Lets a caller distinguish "never
   * attempted yet" (recipient absent from the returned map — e.g. nothing
   * has consumed the queue) from a genuine terminal `FAILED` outcome, so a
   * best-effort send can still surface as failed in a UI instead of looking
   * identical to "still pending" forever.
   */
  async getLatestStatusByRecipient(
    toAddresses: string[],
    template: string,
  ): Promise<Map<string, string>> {
    if (toAddresses.length === 0) return new Map();
    const rows: Array<{ to_address: string; status: string }> =
      await this.dataSource.query(
        `SELECT DISTINCT ON (to_address) to_address, status
         FROM email_logs
         WHERE template = $1 AND to_address = ANY($2::text[])
         ORDER BY to_address, created_at DESC`,
        [template, toAddresses],
      );
    return new Map(rows.map((r) => [r.to_address, r.status]));
  }

  async listLogs(q: { status?: string; search?: string; page: number; limit: number }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.search) where.to_address = ILike(`%${q.search}%`);
    const [data, total] = await this.logs.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    });
    return { data, total, page: q.page, limit: q.limit };
  }

  async stats() {
    const rows = await this.logs
      .createQueryBuilder('e')
      .select('e.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('e.status')
      .getRawMany<{ status: string; count: string }>();
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    return {
      sent: by.SENT ?? 0,
      failed: by.FAILED ?? 0,
      queued: by.QUEUED ?? 0,
      total: (by.SENT ?? 0) + (by.FAILED ?? 0) + (by.QUEUED ?? 0),
    };
  }

  private safeMeta(vars?: Record<string, unknown>): Record<string, any> | undefined {
    if (!vars) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (!SENSITIVE.test(k)) out[k] = v;
    }
    return out;
  }
}
