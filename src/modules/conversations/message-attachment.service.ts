import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MessageAttachment } from '../../entities/Conversations/MessageAttachment';
import { Message } from '../../entities/Conversations/Message';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { CreateMessageAttachmentDto } from './dto/create-message-attachment.dto';
import { StorageService } from '../storage/storage.service';

/**
 * Message attachment metadata.
 *
 * `file_url` holds two different kinds of value depending on origin, and
 * `downloadAccess` is what reconciles them:
 *  - inbound WhatsApp media (WhatsappMediaService) stores the private bucket's
 *    object KEY, never a public URL — reads must go through a signed URL;
 *  - manually-registered attachments (`POST .../attachments`) store whatever
 *    URL the caller already uploaded the file to (no storage provider is
 *    implemented for that path), which is already usable as-is.
 * Tenant isolation: attachments are stamped with the tenant and accessed via
 * the tenant-scoped message.
 */
@Injectable()
export class MessageAttachmentService {
  constructor(
    @InjectRepository(MessageAttachment)
    private readonly attachments: Repository<MessageAttachment>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly storage: StorageService,
  ) {}

  async add(
    tenantId: string,
    messageId: string,
    dto: CreateMessageAttachmentDto,
  ): Promise<MessageAttachment> {
    await this.assertMessage(tenantId, messageId);
    const attachment = this.attachments.create({
      message: { id: messageId } as Message,
      tenant: { id: tenantId } as Tenant,
      file_url: dto.fileUrl,
      file_type: dto.fileType,
      file_name: dto.fileName,
    });
    return this.attachments.save(attachment);
  }

  async listByMessage(tenantId: string, messageId: string): Promise<MessageAttachment[]> {
    await this.assertMessage(tenantId, messageId);
    return this.attachments.find({
      where: { message: { id: messageId }, tenant: { id: tenantId } },
      order: { created_at: 'ASC' },
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const attachment = await this.findOne(tenantId, id);
    await this.attachments.remove(attachment);
  }

  /**
   * Download-access descriptor. `file_url` is either an already-usable URL
   * (manually-registered attachments) or a private-bucket object key (inbound
   * WhatsApp media) — only the latter needs signing. Object storage being
   * unconfigured, or the key having been deleted, must not break the
   * conversation view: the attachment metadata still renders, just without a
   * working link.
   */
  async downloadAccess(tenantId: string, id: string) {
    const attachment = await this.findOne(tenantId, id);
    const stored = attachment.file_url ?? null;

    if (!stored) {
      return {
        attachmentId: attachment.id,
        fileName: attachment.file_name ?? null,
        fileType: attachment.file_type ?? null,
        url: null,
        expiresAt: null,
      };
    }

    if (/^https?:\/\//i.test(stored)) {
      return {
        attachmentId: attachment.id,
        fileName: attachment.file_name ?? null,
        fileType: attachment.file_type ?? null,
        url: stored,
        // Not a signed link — it does not expire on our side.
        expiresAt: null,
      };
    }

    let url: string | null = null;
    if (this.storage.isConfigured()) {
      url = await this.storage.getSignedDownloadUrl(stored);
    }
    return {
      attachmentId: attachment.id,
      fileName: attachment.file_name ?? null,
      fileType: attachment.file_type ?? null,
      url,
      expiresAt: url
        ? new Date(Date.now() + this.storage.signedUrlTtlSeconds * 1000).toISOString()
        : null,
    };
  }

  private async findOne(tenantId: string, id: string): Promise<MessageAttachment> {
    const attachment = await this.attachments.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!attachment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Attachment not found' });
    }
    return attachment;
  }

  private async assertMessage(tenantId: string, messageId: string): Promise<void> {
    if (!(await this.messages.exists({ where: { id: messageId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Message not found' });
    }
  }
}
