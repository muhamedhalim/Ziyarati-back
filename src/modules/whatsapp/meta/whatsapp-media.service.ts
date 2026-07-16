import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Message } from '../../../entities/Conversations/Message';
import { MessageAttachment } from '../../../entities/Conversations/MessageAttachment';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../../common/errors';

import { MetaGraphClient } from './meta-graph.client';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';
import { StorageService } from '../../storage/storage.service';
import {
  WHATSAPP_MEDIA_UPLOAD_POLICY,
  policyAllowsMime,
} from '../../storage/storage.constants';
import { QueueService } from '../../../queue/queue.service';
import type { MetaWebhookMessage } from '../webhooks/whatsapp-webhook.types';

/** Inbound WhatsApp message types that carry a media object. */
export const WHATSAPP_MEDIA_TYPES = [
  'image',
  'document',
  'audio',
  'video',
  'sticker',
] as const;

export type WhatsappMediaType = (typeof WHATSAPP_MEDIA_TYPES)[number];

/**
 * Hard cap on an inbound media download (16 MB — WhatsApp's own documented
 * ceiling for most types). Enforced against Content-Length AND the received
 * bytes: a patient's phone is untrusted input like any other client.
 */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Inbound WhatsApp media: Meta media id → stored object → MessageAttachment.
 *
 * Why this is a queued job rather than part of webhook ingestion: Meta expires
 * a media URL within minutes and requires a second authenticated round-trip to
 * fetch the bytes. Downloading a 16 MB video inline would blow the webhook's
 * fast-200 budget and, on failure, lose the file with no retry. The job stores
 * the media ID and re-resolves the URL each attempt, so a retry hours later
 * still works.
 *
 * Tenant isolation: the credential is resolved from the tenant's own account
 * (a media id is only readable with the token of the WABA that received it),
 * and the stored object key is namespaced per tenant by StorageService.
 */
@Injectable()
export class WhatsappMediaService {
  private readonly logger = new Logger('WhatsappMediaService');

  constructor(
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(MessageAttachment)
    private readonly attachments: Repository<MessageAttachment>,
    private readonly graph: MetaGraphClient,
    private readonly resolver: WhatsappAccountResolver,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  /** True when this inbound message carries a media object worth fetching. */
  static isMediaMessage(message: MetaWebhookMessage): boolean {
    return WHATSAPP_MEDIA_TYPES.includes(message.type as WhatsappMediaType);
  }

  /**
   * Extracts the media descriptor from an inbound Meta message, if any.
   * Meta nests it under a key named after the type (`image`, `document`, …).
   */
  static extract(message: MetaWebhookMessage): {
    mediaId: string;
    mediaType: string;
    mimeType?: string;
    filename?: string;
  } | null {
    const type = message.type;
    if (!type || !WHATSAPP_MEDIA_TYPES.includes(type as WhatsappMediaType)) return null;

    const media = (message as unknown as Record<string, MetaMediaObject | undefined>)[type];
    if (!media?.id) return null;

    return {
      mediaId: media.id,
      mediaType: type,
      mimeType: media.mime_type,
      filename: media.filename,
    };
  }

  /**
   * Queue a download for every media object on an inbound message. Failures to
   * enqueue are logged, never thrown — a media hiccup must not fail the whole
   * webhook event (the text of the message is already handled).
   */
  async enqueueForMessage(
    tenantId: string,
    accountId: string,
    messageId: string,
    message: MetaWebhookMessage,
  ): Promise<void> {
    const media = WhatsappMediaService.extract(message);
    if (!media) return;

    try {
      await this.queue.enqueueWhatsappMediaDownload({
        tenantId,
        accountId,
        messageId,
        mediaId: media.mediaId,
        mediaType: media.mediaType,
        mimeType: media.mimeType,
        filename: media.filename,
      });
    } catch (err) {
      this.logger.error(
        `Failed to enqueue media ${media.mediaId} for message ${messageId}: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * WORKER ENTRY POINT: download one media object and attach it.
   *
   * Idempotent: an attachment already recorded for this message+media is a
   * no-op, so a redelivered webhook or a retried job cannot duplicate the file
   * (or pay to download it twice).
   */
  async downloadAndAttach(job: {
    tenantId: string;
    accountId: string;
    messageId: string;
    mediaId: string;
    mediaType: string;
    mimeType?: string;
    filename?: string;
  }): Promise<{ attached: boolean; reason?: string }> {
    const message = await this.messages.findOne({
      where: { id: job.messageId, tenant: { id: job.tenantId } },
    });
    if (!message) return { attached: false, reason: 'message-missing' };

    if (await this.alreadyAttached(job.tenantId, job.messageId, job.mediaId)) {
      return { attached: false, reason: 'already-attached' };
    }

    // Credentials come from the tenant's own account: a media id is only
    // readable with the token of the WABA that received it, so this doubles as
    // an isolation check.
    const account = await this.resolver.byId(job.tenantId, job.accountId);
    if (!account.accessToken) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp account has no usable credential to download media',
      });
    }

    const metadata = await this.graph.getMediaMetadata(job.mediaId, account.accessToken);
    const mime = this.normalizeMime(metadata.mimeType ?? job.mimeType);

    // Unsupported type → record the attachment WITHOUT the bytes. Staff still
    // see that a file arrived and can ask the patient to resend; silently
    // dropping it would make the conversation lie about what was sent.
    if (!policyAllowsMime(WHATSAPP_MEDIA_UPLOAD_POLICY, mime)) {
      this.logger.warn(
        `Inbound media ${job.mediaId} has unsupported type "${mime}" — recorded without content`,
      );
      await this.saveAttachment(job, { fileType: mime, fileName: job.filename, fileUrl: undefined });
      return { attached: true, reason: 'unsupported-type' };
    }

    const { buffer } = await this.graph.downloadMedia(
      metadata.url,
      account.accessToken,
      MAX_MEDIA_BYTES,
    );

    // Store in the PRIVATE bucket under the WhatsApp-media policy (NOT the
    // stricter verification-document policy). The persisted value is the
    // storage KEY, never a public URL: patient media is served only through
    // short-lived signed URLs, exactly like verification documents.
    const stored = await this.storage.upload(
      {
        tenantId: job.tenantId,
        docType: `whatsapp-${job.mediaType}`,
        mimeType: mime,
        buffer,
        size: buffer.byteLength,
        // WhatsApp media often has no filename; the media id keeps the record
        // identifiable either way.
        originalName: job.filename ?? job.mediaId,
      },
      WHATSAPP_MEDIA_UPLOAD_POLICY,
    );

    await this.saveAttachment(job, {
      fileType: mime,
      fileName: job.filename,
      fileUrl: stored.storageKey,
    });

    this.logger.log(
      `Attached ${job.mediaType} (${buffer.byteLength} bytes) to message ${job.messageId}`,
    );
    return { attached: true };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Strips any `; charset=…` parameter and normalizes case for matching. */
  private normalizeMime(mime: string | undefined): string {
    return (mime ?? 'application/octet-stream').toLowerCase().split(';')[0].trim();
  }

  /**
   * Idempotency guard. `saveAttachment` always writes the Meta media id into
   * `file_name` when the message carried no filename, so a redelivered webhook
   * or retried job finds the existing row instead of downloading and attaching
   * the same file twice.
   */
  private alreadyAttached(
    tenantId: string,
    messageId: string,
    mediaId: string,
  ): Promise<boolean> {
    return this.attachments.exists({
      where: {
        message: { id: messageId },
        tenant: { id: tenantId },
        provider_media_id: mediaId,
      },
    });
  }

  private async saveAttachment(
    job: { tenantId: string; messageId: string; mediaId: string },
    file: { fileType?: string; fileName?: string; fileUrl?: string },
  ): Promise<void> {
    await this.attachments.save(
      this.attachments.create({
        message: { id: job.messageId } as Message,
        tenant: { id: job.tenantId } as Tenant,
        file_type: file.fileType,
        file_name: file.fileName,
        file_url: file.fileUrl,
        provider_media_id: job.mediaId,
      }),
    );
  }
}

/** Meta's inbound media object (the fields we consume). */
interface MetaMediaObject {
  id?: string;
  mime_type?: string;
  sha256?: string;
  filename?: string;
}
