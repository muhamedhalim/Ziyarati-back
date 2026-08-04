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
  WHATSAPP_SENDING_STALE_MS,
} from './whatsapp.constants';
import { missingVariables } from './template-variables.util';

interface ResolvedRecipient {
  to: string;
  recipientType: string;
  recipientId?: string;
  /** FND-024: set only when the recipient resolved to a known CRM customer who has opted out. */
  optedOutAt?: Date | null;
}

const PG_UNIQUE_VIOLATION = '23505';

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
   * `claim` (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.11,
   * recovery hardened further in §0.8.5): when supplied — ONLY the
   * queued/scheduled path does this — this method first atomically claims the
   * given `NotificationLog` row (-> SENDING) before doing anything else. If
   * the claim affects zero rows, the row is currently claimed by a genuinely
   * in-flight send, so this call returns immediately without sending anything
   * a second time. On completion the SAME row is updated in place (not a
   * second `recordLog` insert, which is what happened before this fix).
   *
   * RECOVERY (§0.8.5): the claim accepts a row in EITHER QUEUED (never
   * claimed) or STALE SENDING (claimed more than `WHATSAPP_SENDING_STALE_MS`
   * ago — the worker that claimed it crashed before ever writing SENT/FAILED).
   * Before this fix the claim only matched `status = QUEUED`, so a worker
   * crash mid-send left the row stuck in SENDING FOREVER: BullMQ's own
   * stalled-job detection still redelivers that exact job (same jobId, same
   * payload) to another worker, but the redelivered call's claim attempt was
   * always rejected as "already claimed" — the message was simply never sent
   * and never retried, silently.
   *
   * RECONCILIATION (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md
   * §0.11): a STALE reclaim (as opposed to a fresh QUEUED claim) can mean the
   * PRIOR attempt already got a successful response from Meta — a real
   * `provider_ref` was persisted — and crashed only during the FINAL status
   * write. Resending in that case would deliver the message to the customer
   * TWICE. This is now checked explicitly: if the reclaimed row already
   * carries a `provider_ref`, the provider is never called again — the row is
   * reconciled to SENT using the `provider_ref` already on file instead. The
   * one window this cannot close: a crash strictly BETWEEN the provider
   * accepting the message and OUR immediate `provider_ref` write below — that
   * remains a genuine, unavoidable at-least-once gap (no transactional
   * coordination with Meta is possible), and is documented here rather than
   * silently assumed away.
   */
  async sendTemplateMessage(
    tenantId: string,
    templateId: string,
    dto: SendTemplateMessageDto,
    claim?: { logId: string },
  ) {
    let priorProviderRef: string | null | undefined;
    if (claim) {
      const claimResult = await this.claimQueuedLog(tenantId, claim.logId);
      if (!claimResult.claimed) {
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
      priorProviderRef = claimResult.priorProviderRef;
    }

    const account = await this.router.resolveForSend(tenantId, {
      accountId: dto.accountId,
      branchId: dto.branchId,
    });
    const template = await this.templates.getSendableTemplate(tenantId, templateId);
    const recipient = await this.resolveRecipient(tenantId, dto);

    if (claim && priorProviderRef) {
      // See RECONCILIATION above: the row we just reclaimed already has a
      // provider_ref from a prior attempt that crashed before finalizing —
      // treat it as already delivered rather than risk a real duplicate send.
      this.logger.warn(
        `whatsapp send job for log ${claim.logId} was reclaimed from a stale SENDING row that ALREADY has ` +
          `provider_ref=${priorProviderRef} — a prior attempt reached the provider before crashing. Reconciling ` +
          'to SENT WITHOUT resending, to avoid a guaranteed duplicate delivery.',
      );
      const log = await this.updateClaimedLog(claim.logId, template.id, recipient, WHATSAPP_DELIVERY_STATUS.SENT, {
        sentAt: new Date(),
        providerRef: priorProviderRef,
      });
      return {
        status: WHATSAPP_DELIVERY_STATUS.SENT,
        providerMessageId: priorProviderRef,
        error: undefined,
        recipient: { type: recipient.recipientType, id: recipient.recipientId, to: recipient.to },
        logId: log.id,
        reconciled: true,
      };
    }

    // FND-021: refuse a send that is missing a placeholder the template's
    // BODY component actually declares, BEFORE the provider call. Same
    // shared seam as the opt-out check below — the scheduled/automation path
    // already supplies every required variable (it is the reference
    // implementation), so this passes harmlessly there; it is the manual
    // Send dialog that previously had no variable input at all.
    const missing = missingVariables(template.components, dto.variables);
    if (missing.length > 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Missing required template variable(s): ${missing.join(', ')}`,
        publicContext: { missing },
      });
    }

    // FND-024: refuse a send to a customer who has opted out, BEFORE the
    // provider call — this is the single send seam (immediate,
    // scheduled-via-worker, and campaign sends via
    // WhatsappCampaignDeliveryProvider all reuse it), so this one check
    // covers the ad-hoc/direct path (which had NO consent check at all) and
    // backstops the campaign path (which already gates earlier, at
    // CampaignDispatchService.checkConsent, for its own SKIPPED bookkeeping).
    // An opt-out that arrives after a job was enqueued is honored here, at
    // dispatch time, not just at enqueue time.
    if (recipient.optedOutAt) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This customer has opted out of WhatsApp messages',
      });
    }

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

    // provider_ref is written REGARDLESS of what happens after this point —
    // narrows (does not eliminate — see RECONCILIATION above) the crash
    // window in which Meta has accepted the message but we have no durable
    // record of it, and is what a stale reclaim checks on its next attempt.
    const log = claim
      ? await this.updateClaimedLog(claim.logId, template.id, recipient, status, {
          error: result.success ? undefined : result.error,
          sentAt: result.success ? new Date() : undefined,
          providerRef: result.success ? result.providerMessageId : undefined,
        })
      : await this.recordLog(tenantId, template.id, recipient, status, {
          error: result.success ? undefined : result.error,
          sentAt: result.success ? new Date() : undefined,
          providerRef: result.success ? result.providerMessageId : undefined,
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

  /**
   * Atomic claim to SENDING. Matches a row that is either QUEUED (fresh) or a
   * STALE SENDING (claimed more than `WHATSAPP_SENDING_STALE_MS` ago, or with
   * no `claimed_at` at all — a row from before this column existed): both are
   * legitimate to (re)claim. A row genuinely SENDING within the stale window
   * is NOT matched, so a real in-flight send can never be claimed twice.
   * Returns `claimed: false` if the row is currently in-flight, already
   * SENT/FAILED, or doesn't exist.
   *
   * `priorProviderRef` (best-effort read, taken before the claim UPDATE — the
   * UPDATE's WHERE clause remains the actual atomicity guard, this is purely
   * informational) lets the caller detect a stale-SENDING reclaim whose prior
   * attempt already reached the provider — see the RECONCILIATION docstring
   * on `sendTemplateMessage`.
   */
  private async claimQueuedLog(
    tenantId: string,
    logId: string,
  ): Promise<{ claimed: boolean; priorProviderRef?: string | null }> {
    const existing = await this.logs.findOne({ where: { id: logId, tenant: { id: tenantId } } });
    const staleCutoff = new Date(Date.now() - WHATSAPP_SENDING_STALE_MS);
    const result = await this.logs
      .createQueryBuilder()
      .update(NotificationLog)
      .set({ status: WHATSAPP_DELIVERY_STATUS.SENDING, claimed_at: () => 'NOW()' })
      .where(
        'id = :logId AND "tenantId" = :tenantId AND (status = :queued OR (status = :sending AND (claimed_at IS NULL OR claimed_at < :staleCutoff)))',
        {
          logId,
          tenantId,
          queued: WHATSAPP_DELIVERY_STATUS.QUEUED,
          sending: WHATSAPP_DELIVERY_STATUS.SENDING,
          staleCutoff,
        },
      )
      .execute();
    const claimed = (result.affected ?? 0) > 0;
    return { claimed, priorProviderRef: claimed ? existing?.provider_ref : undefined };
  }

  /**
   * Claim-or-detect-duplicate for a business-keyed send that has NO
   * pre-existing `NotificationLog` row of its own — e.g. the workflow
   * engine's WHATSAPP action, which sends a free-form SESSION message via
   * `WhatsappMessagingService.sendSession` directly and has no
   * QUEUED/SENDING lifecycle to claim (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.11). Inserts a SENDING row keyed by
   * `sourceRef`; the column's partial-unique index (migration
   * `WorkflowActionSourceRef1730016000000`) makes a second insert for the
   * SAME `sourceRef` fail with 23505 instead of silently succeeding — that is
   * the actual atomicity guarantee, not the insert-then-check pattern this
   * method's code happens to read like.
   */
  async claimBySourceRef(
    tenantId: string,
    channel: string,
    sourceRef: string,
  ): Promise<{ claimed: boolean; log: NotificationLog }> {
    try {
      const log = await this.logs.save(
        this.logs.create({
          tenant: { id: tenantId } as Tenant,
          channel,
          status: WHATSAPP_DELIVERY_STATUS.SENDING,
          source_ref: sourceRef,
          claimed_at: new Date(),
        }),
      );
      return { claimed: true, log };
    } catch (err) {
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        const existing = await this.logs.findOneBy({ source_ref: sourceRef });
        if (existing) return { claimed: false, log: existing };
      }
      throw err;
    }
  }

  /** Finalizes a row claimed via `claimBySourceRef` — same row, no second insert. */
  async finalizeBySourceRef(
    logId: string,
    status: string,
    opts: { providerRef?: string; error?: string; sentAt?: Date },
  ): Promise<void> {
    await this.logs.update(
      { id: logId },
      { status, provider_ref: opts.providerRef, error_message: opts.error, sent_at: opts.sentAt },
    );
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
      return {
        to: customer.phone,
        recipientType: WHATSAPP_RECIPIENT_TYPE.CUSTOMER,
        recipientId: customer.id,
        optedOutAt: customer.opted_out_at,
      };
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
    opts: { error?: string; sentAt?: Date; providerRef?: string },
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
      provider_ref: opts.providerRef,
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
    opts: { error?: string; sentAt?: Date; providerRef?: string },
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
        provider_ref: opts.providerRef,
      },
    );
    const updated = await this.logs.findOneBy({ id: logId });
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Claimed notification log vanished mid-send' });
    return updated;
  }
}
