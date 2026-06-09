import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MessageAttachment } from '../../entities/Conversations/MessageAttachment';
import { Message } from '../../entities/Conversations/Message';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { CreateMessageAttachmentDto } from './dto/create-message-attachment.dto';

/**
 * Message attachment METADATA (no file storage implementation).
 *
 * Tenant isolation: attachments are stamped with the tenant and accessed via the
 * tenant-scoped message. `downloadAccess` is an abstraction point that returns a
 * (placeholder) time-limited access descriptor — a real storage adapter would
 * mint a signed URL here.
 */
@Injectable()
export class MessageAttachmentService {
  constructor(
    @InjectRepository(MessageAttachment)
    private readonly attachments: Repository<MessageAttachment>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
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
   * Download-access abstraction. Returns a time-limited descriptor for the
   * stored file URL. No storage provider is implemented — a real adapter would
   * sign the URL here (S3 presign / CDN token).
   */
  async downloadAccess(tenantId: string, id: string) {
    const attachment = await this.findOne(tenantId, id);
    return {
      attachmentId: attachment.id,
      fileName: attachment.file_name ?? null,
      fileType: attachment.file_type ?? null,
      url: attachment.file_url ?? null,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
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
