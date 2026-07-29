import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { SendTemplateMessageDto } from './dto/send-template-message.dto';
import { UsageService } from '../subscription-billing/usage.service';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import {
  WHATSAPP_CHANNEL,
  WHATSAPP_DELIVERY_STATUS,
  WHATSAPP_RECIPIENT_TYPE,
} from './whatsapp.constants';

interface ResolvedRecipient {
  to: string;
  recipientType: string;
  recipientId?: string;
}

/**
 * Orchestrates WhatsApp sends: validates the account (active) + template
 * (approved) + recipient, delegates delivery to the provider abstraction, and
 * records the outcome on `notification_logs` (channel = WHATSAPP) — the source
 * of truth for analytics (there is no dedicated WhatsApp message table).
 *
 * Tenant isolation: account/template/recipient are all loaded tenant-scoped; the
 * log row is stamped with the tenant.
 */
@Injectable()
export class WhatsappExecutionService {
  private readonly logger = new Logger('WhatsappExecutionService');

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logs: Repository<NotificationLog>,
    @InjectRepository(WhatsappContact)
    private readonly contacts: Repository<WhatsappContact>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly router: WhatsappMessageRouter,
    private readonly templates: WhatsappTemplateService,
    private readonly messaging: WhatsappMessagingService,
    private readonly queue: QueueService,
    private readonly usage: UsageService,
    private readonly ctx: TenantContextService,
  ) {}

  /**
   * Sends a template message immediately and records the outcome.
   *
   * `claim` (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.11):
   * when supplied — ONLY the queued/scheduled path does this — this method
   * first atomically claims the given QUEUED `NotificationLog` row
   * (QUEUED -> SENDING, `WHERE status = QUEUED`) before doing anything else.
   * If the claim affects zero rows, the row has already been claimed or
   * finished by a prior (possibly redelivered) invocation of the SAME job, so
   * this call returns immediately without sending anything a second time —
   * this queue previously had no jobId and no other idempotency guard at all.
   * On completion the SAME row is updated in place (not a second `recordLog`
   * insert, which is what happened before this fix).
   */
  async sendTemplateMessage(
    tenantId: string,
    templateId: string,
    dto: SendTemplateMessageDto,
    claim?: { logId: string },
  ) {
    if (claim) {
      const claimed = await this.claimQueuedLog(tenantId, claim.logId);
      if (!claimed) {
        this.logger.warn(`whatsapp send job for log ${claim.logId} was already claimed/handled — skipping duplicate delivery`);
        return {
          status: WHATSAPP_DELIVERY_STATUS.SENDING,
          providerMessageId: undefined,
          error: undefined,
          recipient: undefined,
          logId: claim.logId,
          duplicate: true,
        };
      }
    }

    const account = await this.router.resolveForSend(tenantId, {
      accountId: dto.accountId,
      branchId: dto.branchId,
    });
    const template = await this.templates.getSendableTemplate(tenantId, templateId);
    const recipient = await this.resolveRecipient(tenantId, dto);

    // Quota: WhatsApp messages are usage-limited. This is the single send seam
    // (immediate, scheduled-via-worker, and campaign sends all reuse it), so the
    // check/meter here covers every path — including background jobs. No-op under
    // free mode / override; throws 422 when the monthly message cap is reached.
    await this.usage.assertWithinLimit(tenantId, USAGE_METRIC.WHATSAPP_MESSAGES, 1);

    let result;
    try {
      result = await this.messaging.send({
        tenantId,
        accountId: account.id,
        mode: account.mode,
        phoneNumberId: account.phoneNumberId,
        to: recipient.to,
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        variables: dto.variables,
      });
    } catch (err) {
      // cid lets this be traced back to the originating HTTP request or queue
      // job — this send path is shared by immediate, scheduled and campaign
      // sends, so a bare message alone can't be correlated to any of them.
      this.logger.error(
        `[cid=${this.ctx.getCorrelationId() ?? '-'}] WhatsApp provider threw during send (account=${account.id})`,
        err as Error,
      );
      result = { success: false, error: (err as Error)?.message ?? 'provider error' };
    }

    const status = result.success
      ? WHATSAPP_DELIVERY_STATUS.SENT
      : WHATSAPP_DELIVERY_STATUS.FAILED;

    // Meter only successful sends against the monthly quota (best-effort).
    if (result.success) {
      await this.usage.increment(tenantId, USAGE_METRIC.WHATSAPP_MESSAGES, 1);
    }

    const log = claim
      ? await this.updateClaimedLog(claim.logId, template.id, recipient, status, {
          error: result.success ? undefined : result.error,
          sentAt: result.success ? new Date() : undefined,
        })
      : await this.recordLog(tenantId, template.id, recipient, status, {
          error: result.success ? undefined : result.error,
          sentAt: result.success ? new Date() : undefined,
        });

    return {
      status,
      providerMessageId: result.success ? result.providerMessageId : undefined,
      // Surfaced (not just logged) so callers can classify the failure —
      // CampaignDispatchService needs the provider's text to decide
      // TRANSIENT (retry) vs PERMANENT (don't). Safe to expose: provider error
      // strings carry no credentials.
      error: result.success ? undefined : result.error,
      recipient: { type: recipient.recipientType, id: recipient.recipientId, to: recipient.to },
      logId: log.id,
    };
  }

  /** Atomic QUEUED -> SENDING claim. Returns false if the row was already claimed/handled (or doesn't exist). */
  private async claimQueuedLog(tenantId: string, logId: string): Promise<boolean> {
    const result = await this.logs
      .createQueryBuilder()
      .update(NotificationLog)
      .set({ status: WHATSAPP_DELIVERY_STATUS.SENDING })
      .where('id = :logId AND "tenantId" = :tenantId AND status = :queued', {
        logId,
        tenantId,
        queued: WHATSAPP_DELIVERY_STATUS.QUEUED,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * Queues a template message for future send (status QUEUED). Queue-ready seam:
   * a BullMQ delayed job would carry the send params; here we validate and
   * record the QUEUED log so it is auditable.
   */
  async scheduleMessage(
    tenantId: string,
    templateId: string,
    dto: SendTemplateMessageDto,
  ) {
    if (!dto.scheduledAt) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'scheduledAt is required to schedule a message',
      });
    }
    // Validate routing + template + recipient up front so scheduling fails fast
    // (the actual account is re-resolved by the worker at send time).
    await this.router.resolveForSend(tenantId, {
      accountId: dto.accountId,
      branchId: dto.branchId,
    });
    await this.templates.getSendableTemplate(tenantId, templateId);
    const recipient = await this.resolveRecipient(tenantId, dto);

    const log = await this.recordLog(
      tenantId,
      templateId,
      recipient,
      WHATSAPP_DELIVERY_STATUS.QUEUED,
      {},
    );

    // Produce a DELAYED send job; the whatsapp worker performs the actual send
    // (reusing sendTemplateMessage) at scheduledAt. `logId` + a deterministic
    // jobId (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.11) are
    // what let the worker claim this exact row atomically — this queue
    // previously had NEITHER a jobId NOR any DB-level dedupe.
    const delay = Math.max(0, new Date(dto.scheduledAt).getTime() - Date.now());
    await this.queue.enqueueWhatsappSend(
      {
        tenantId,
        templateId,
        logId: log.id,
        payload: {
          accountId: dto.accountId,
          branchId: dto.branchId,
          contactId: dto.contactId,
          customerId: dto.customerId,
          toWaId: dto.toWaId,
          variables: dto.variables,
        },
      },
      { delay, jobId: `whatsapp-send-${log.id}` },
    );

    return { status: WHATSAPP_DELIVERY_STATUS.QUEUED, scheduledAt: dto.scheduledAt, logId: log.id };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async resolveRecipient(
    tenantId: string,
    dto: SendTemplateMessageDto,
  ): Promise<ResolvedRecipient> {
    if (dto.contactId) {
      const contact = await this.contacts.findOne({
        where: { id: dto.contactId, tenant: { id: tenantId } },
      });
      if (!contact) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Contact not found' });
      }
      if (!contact.wa_id) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Contact has no WhatsApp id',
        });
      }
      return { to: contact.wa_id, recipientType: WHATSAPP_RECIPIENT_TYPE.CONTACT, recipientId: contact.id };
    }

    if (dto.customerId) {
      const customer = await this.customers.findOne({
        where: { id: dto.customerId, tenant: { id: tenantId } },
      });
      if (!customer) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Customer not found' });
      }
      return { to: customer.phone, recipientType: WHATSAPP_RECIPIENT_TYPE.CUSTOMER, recipientId: customer.id };
    }

    if (dto.toWaId) {
      return { to: dto.toWaId, recipientType: WHATSAPP_RECIPIENT_TYPE.RAW };
    }

    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: 'Provide one recipient: contactId, customerId, or toWaId',
    });
  }

  private recordLog(
    tenantId: string,
    templateId: string,
    recipient: ResolvedRecipient,
    status: string,
    opts: { error?: string; sentAt?: Date },
  ): Promise<NotificationLog> {
    const log = this.logs.create({
      tenant: { id: tenantId } as Tenant,
      template_id: templateId,
      recipient_type: recipient.recipientType,
      recipient_id: recipient.recipientId,
      channel: WHATSAPP_CHANNEL,
      status,
      error_message: opts.error,
      sent_at: opts.sentAt,
    });
    return this.logs.save(log);
  }

  /**
   * Updates the SAME log row a queued send already claimed, in place, instead
   * of `recordLog`'s INSERT (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.11). Before this fix, a queued send
   * produced TWO rows: the QUEUED one from `scheduleMessage` and a second,
   * separate one the worker created fresh — this collapses back to one.
   */
  private async updateClaimedLog(
    logId: string,
    templateId: string,
    recipient: ResolvedRecipient,
    status: string,
    opts: { error?: string; sentAt?: Date },
  ): Promise<NotificationLog> {
    await this.logs.update(
      { id: logId },
      {
        template_id: templateId,
        recipient_type: recipient.recipientType,
        recipient_id: recipient.recipientId,
        status,
        error_message: opts.error,
        sent_at: opts.sentAt,
      },
    );
    const updated = await this.logs.findOneBy({ id: logId });
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Claimed notification log vanished mid-send' });
    return updated;
  }
}
