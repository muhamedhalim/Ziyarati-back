import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ILike } from 'typeorm';

import { EmailLog } from '../../entities/System/EmailLog';
import { EmailSendJob } from '../../queue/job-data.interface';
import { EmailProviderFactory } from './providers/email-provider.factory';
import { resolveEmailConfig } from './email.config';
import { renderEmail } from './email.templates';

/** Keys stripped from stored metadata (never persist tokens/links/PII). */
const SENSITIVE = /token|url|password|secret|code|otp/i;

/**
 * Renders a template, sends it through the active provider, and records the
 * attempt in `email_logs`. Idempotent: a job whose idempotency key is already
 * SENT is skipped. Callable directly (sync mode) or by the worker's
 * EmailProcessor. Transient failures re-throw so BullMQ retries with backoff.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(
    @InjectRepository(EmailLog)
    private readonly logs: Repository<EmailLog>,
    private readonly factory: EmailProviderFactory,
    private readonly config: ConfigService,
  ) {}

  async deliver(job: EmailSendJob): Promise<void> {
    // Idempotency: don't re-send an already-delivered email.
    if (job.idempotencyKey) {
      const existing = await this.logs.findOne({
        where: { idempotency_key: job.idempotencyKey },
      });
      if (existing?.status === 'SENT') {
        this.logger.log(`Skipping duplicate email (${job.idempotencyKey})`);
        return;
      }
    }

    const cfg = resolveEmailConfig(this.config);
    const ctx = {
      appUrl: cfg.appUrl,
      locale: job.locale ?? cfg.defaultLocale,
      brand: 'Ziyarati',
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
    });

    await this.record(job, rendered.subject, provider.name, ctx.locale, toAddr, result);

    if (!result.success && result.transient) {
      // Re-throw so BullMQ retries with the configured backoff.
      throw new Error(result.error ?? 'Transient email delivery failure');
    }
  }

  private async record(
    job: EmailSendJob,
    subject: string,
    provider: string,
    locale: string,
    toAddr: string,
    result: { success: boolean; providerMessageId?: string; error?: string },
  ): Promise<void> {
    try {
      let log = job.idempotencyKey
        ? await this.logs.findOne({ where: { idempotency_key: job.idempotencyKey } })
        : null;
      if (!log) {
        log = this.logs.create({
          idempotency_key: job.idempotencyKey,
          to_address: toAddr,
          tenant_id: job.tenantId ?? undefined,
        });
      }
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
        log.error = result.error?.slice(0, 1000);
      }
      await this.logs.save(log);
    } catch (err) {
      // Logging failure must never break delivery.
      this.logger.warn(`email_log write failed: ${(err as Error)?.message}`);
    }
  }

  // ── Read side (observability) ────────────────────────────────────────────

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
