import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { WhatsappAccountService } from './whatsapp-account.service';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { SendTemplateMessageDto } from './dto/send-template-message.dto';
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
    private readonly accounts: WhatsappAccountService,
    private readonly templates: WhatsappTemplateService,
    private readonly messaging: WhatsappMessagingService,
  ) {}

  /** Sends a template message immediately and records the outcome. */
  async sendTemplateMessage(
    tenantId: string,
    templateId: string,
    dto: SendTemplateMessageDto,
  ) {
    const account = await this.accounts.findEntityForSend(tenantId, dto.accountId);
    const template = await this.templates.getSendableTemplate(tenantId, templateId);
    const recipient = await this.resolveRecipient(tenantId, dto);

    let result;
    try {
      result = await this.messaging.send({
        tenantId,
        accountId: account.id,
        to: recipient.to,
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        variables: dto.variables,
      });
    } catch (err) {
      this.logger.error('WhatsApp provider threw during send', err as Error);
      result = { success: false, error: (err as Error)?.message ?? 'provider error' };
    }

    const status = result.success
      ? WHATSAPP_DELIVERY_STATUS.SENT
      : WHATSAPP_DELIVERY_STATUS.FAILED;

    const log = await this.recordLog(tenantId, template.id, recipient, status, {
      error: result.success ? undefined : result.error,
      sentAt: result.success ? new Date() : undefined,
    });

    return {
      status,
      providerMessageId: result.success ? result.providerMessageId : undefined,
      recipient: { type: recipient.recipientType, id: recipient.recipientId, to: recipient.to },
      logId: log.id,
    };
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
    await this.accounts.findEntityForSend(tenantId, dto.accountId);
    await this.templates.getSendableTemplate(tenantId, templateId);
    const recipient = await this.resolveRecipient(tenantId, dto);

    const log = await this.recordLog(
      tenantId,
      templateId,
      recipient,
      WHATSAPP_DELIVERY_STATUS.QUEUED,
      {},
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
}
