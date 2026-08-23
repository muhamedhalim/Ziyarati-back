import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AppError, ErrorCode } from '../../../common/errors';
import { StorageService } from '../../storage/storage.service';
import {
  GUEST_ATTACHMENT_MAX_BYTES,
  GUEST_CHAT_ATTACHMENT_UPLOAD_POLICY,
  assertMagicBytes,
  extensionMatchesMimeForPolicy,
  hasSignature,
  policyAllowsMime,
} from '../../storage/storage.constants';
import { AiAttachmentStagingService } from '../../ai-attachment/ai-attachment-staging.service';
import {
  decodeMultipartFilename,
  sanitizeDisplayFilename,
  sanitizePromptFilename,
} from '../../ai-attachment/ai-attachment.constants';
import type { ConversationAttachment } from '../../ai-orchestrator/ai-channel.constants';
import { GuestAttachmentExtractionService } from './guest-attachment-extraction.service';

/** What the visitor's browser is told about an accepted file. */
export interface GuestAttachmentView {
  id: string;
  /** Unicode-preserving display name — NOT the name the model is shown. */
  name: string;
  mimeType: string;
  size: number;
  status: 'ready' | 'unreadable';
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Accepts a file from an ANONYMOUS visitor of the public AI chat.
 *
 * This is the only place in the product where an unauthenticated stranger can
 * put bytes in the bucket, so the order of checks below is the security
 * design, not an implementation detail. Each gate runs before the work it
 * protects:
 *
 *   1. rate limit      — before any parsing, so a flood costs a Redis INCR
 *   2. presence + size — before the bytes are inspected
 *   3. declared MIME   — must be one of four the policy names
 *   4. extension       — must agree with the MIME (defeats `x.pdf.exe`)
 *   5. magic bytes     — must agree with BOTH (defeats a renamed executable)
 *   6. store           — `StorageService.upload` re-runs 3-5 independently
 *   7. extract         — only now is a parser pointed at attacker bytes
 *
 * NOTHING the client says about the file is trusted at any step: the MIME and
 * the extension are treated as claims to be checked against the content, and
 * the filename is treated as hostile free text (see `sanitizePromptFilename`).
 *
 * Storage note: every guest shares the synthetic discovery tenant, so the R2
 * key's tenant prefix is NOT the isolation boundary here — one guest cannot
 * reach another's file because the staging key is derived from the owner's
 * subject and redemption binds the descriptor to a conversation whose
 * ownership `AiConversationAccessService` already enforces.
 */
@Injectable()
export class GuestAttachmentService {
  private readonly logger = new Logger('GuestAttachmentService');

  constructor(
    private readonly storage: StorageService,
    private readonly staging: AiAttachmentStagingService,
    private readonly extraction: GuestAttachmentExtractionService,
  ) {}

  async upload(
    file: UploadedFile | undefined,
    owner: { guestId: string; tenantId: string },
  ): Promise<GuestAttachmentView> {
    await this.staging.assertUploadAllowed(owner.guestId);

    this.assertAcceptable(file);
    // Repair busboy's latin1 decode BEFORE either sanitizer sees the name, or
    // an Arabic filename reaches the visitor as mojibake — and irreversibly
    // so, since the display sanitizer strips the C1 range the mis-decoded
    // continuation bytes land in. Every downstream name derives from this one.
    const accepted: UploadedFile = {
      ...(file as UploadedFile),
      originalname: decodeMultipartFilename((file as UploadedFile).originalname),
    };

    const stored = await this.storage.upload(
      {
        tenantId: owner.tenantId,
        docType: 'guest-chat-attachments',
        originalName: accepted.originalname,
        mimeType: accepted.mimetype,
        size: accepted.size,
        buffer: accepted.buffer,
      },
      GUEST_CHAT_ATTACHMENT_UPLOAD_POLICY,
    );

    const extracted = await this.extraction.extract(
      accepted.buffer,
      accepted.mimetype,
      { tenantId: owner.tenantId },
    );

    const attachment: ConversationAttachment = {
      id: randomUUID(),
      promptName: sanitizePromptFilename(accepted.originalname),
      mimeType: accepted.mimetype,
      size: accepted.size,
      storageKey: stored.storageKey,
      text: extracted.text,
      status: extracted.status,
      at: new Date().toISOString(),
    };
    await this.staging.stage(owner.guestId, attachment);

    // Logged with the SANITIZED name — a log line is a place a filename can
    // do damage too (log injection, and every downstream viewer of it).
    this.logger.log(
      `Guest attachment accepted: ${attachment.promptName} (${accepted.mimetype}, ${accepted.size}B, ${extracted.status})`,
    );

    return {
      id: attachment.id,
      name: sanitizeDisplayFilename(accepted.originalname),
      mimeType: attachment.mimeType,
      size: attachment.size,
      status: attachment.status,
    };
  }

  /**
   * Removes a staged file the visitor changed their mind about.
   *
   * Returns nothing and throws nothing for an unknown id, deliberately: a
   * delete that 404s for "not yours" and 204s for "yours" is an existence
   * oracle over other guests' attachment ids. Both answers are identical.
   */
  async remove(id: string, owner: { guestId: string }): Promise<void> {
    await this.staging.discard(owner.guestId, id);
  }

  /**
   * The client-facing gates, each mapped to its OWN error code so the widget
   * can say which rule was broken in the visitor's language instead of
   * rendering an English developer string.
   */
  private assertAcceptable(file: UploadedFile | undefined): void {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new AppError(ErrorCode.FILE_CONTENT_MISMATCH, {
        message: 'No file was received, or the file is empty',
      });
    }
    // Multer's own `fileSize` limit already truncates above this, but the
    // limit is configured at the interceptor and this check is what turns
    // "too big" into a code the client can act on.
    if (file.size > GUEST_ATTACHMENT_MAX_BYTES) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE, {
        message: 'File exceeds the maximum allowed size',
      });
    }
    const mime = file.mimetype;
    if (!policyAllowsMime(GUEST_CHAT_ATTACHMENT_UPLOAD_POLICY, mime)) {
      throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
        message: 'This file type is not supported',
      });
    }
    if (
      !extensionMatchesMimeForPolicy(
        file.originalname,
        mime,
        GUEST_CHAT_ATTACHMENT_UPLOAD_POLICY,
      )
    ) {
      throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
        message: 'File extension does not match its content type',
      });
    }
    // Every type this policy accepts has a known signature, so a format that
    // cannot be verified here is a bug in the policy, not an acceptable file.
    if (!hasSignature(mime) || !this.signatureMatches(file.buffer, mime)) {
      throw new AppError(ErrorCode.FILE_CONTENT_MISMATCH, {
        message: 'File content does not match its declared type',
      });
    }
  }

  /**
   * Magic-byte check expressed as a boolean.
   *
   * `assertMagicBytes` throws `BAD_REQUEST`, which is right for the tenant
   * document path it was written for but wrong here — this surface promises
   * `FILE_CONTENT_MISMATCH`. Rather than duplicate the signature table (two
   * copies would drift), the shared implementation is reused and its throw is
   * converted.
   */
  private signatureMatches(buffer: Buffer, mime: string): boolean {
    try {
      assertMagicBytes(buffer, mime);
      return true;
    } catch {
      return false;
    }
  }
}
