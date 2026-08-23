import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { AppRedisService } from '../../queue/app-redis.service';
import { cacheKeyPrefix } from '../../queue/queue.constants';
import { DegradedModeLogLimiter } from '../../queue/degraded-mode-log-limiter';
import { AppError, ErrorCode } from '../../common/errors';
import type { ConversationAttachment } from '../ai-orchestrator/ai-channel.constants';
import {
  ATTACHMENT_STAGING_TTL_SECONDS,
  ATTACHMENT_UPLOAD_MAX_PER_WINDOW,
  ATTACHMENT_UPLOAD_WINDOW_SECONDS,
} from './ai-attachment.constants';

declare module 'ioredis' {
  interface Redis {
    aiAttachmentUploadRecord(key: string, ttlSeconds: string): Promise<number>;
  }
}

/** What a redemption produced, including what it could NOT find. */
export interface AttachmentRedemption {
  /** Descriptors now bound to the conversation. */
  attachments: ConversationAttachment[];
  /**
   * Ids the caller asked for that no longer exist (expired, already redeemed
   * into a DIFFERENT conversation, or never belonged to this principal).
   *
   * Surfaced rather than silently dropped: a visitor who attached a report and
   * asked "what does this say?" must not be answered as though no file had
   * been mentioned. The prompt layer tells the model to say so.
   */
  missing: string[];
}

/**
 * Short-lived custody of an uploaded chat attachment, between the HTTP upload
 * that produced it and the chat turn that uses it.
 *
 * WHY REDIS AND NOT THE DATABASE. At upload time there is frequently no
 * conversation yet — the visitor opens the widget, attaches a report and only
 * then types the first message, which is the turn that creates the
 * conversation row. There is nothing to attach the file to. Rather than add a
 * table (and a migration) for state whose entire useful life is measured in
 * minutes, the descriptor waits in Redis under a key derived from the OWNER,
 * and the first turn that names it moves it into the conversation's existing
 * `session` jsonb. No schema change, and abandoned uploads expire themselves.
 *
 * WHY THE KEY IS DERIVED FROM THE OWNER. Every guest shares the one synthetic
 * discovery tenant, so a tenant prefix isolates nothing here. The owner's
 * subject is part of the key, so guest B asking to redeem guest A's
 * attachment id simply computes a key that does not exist — the isolation is
 * structural rather than a comparison someone could forget to write. The
 * subject is hashed for the same reason `AiWsRateLimitService` hashes its
 * identity: Redis keys surface in `MONITOR`, `SLOWLOG` and RDB dumps.
 *
 * Redemption is SINGLE-USE (`GETDEL`): the same upload can never be attached
 * to two conversations, and a captured id cannot be replayed after the turn
 * that consumed it.
 */
@Injectable()
export class AiAttachmentStagingService {
  private readonly logger = new Logger('AiAttachmentStagingService');
  private readonly degradedLog = new DegradedModeLogLimiter(
    this.logger,
    'AI attachment staging',
  );

  // KEYS: [counterKey] ARGV: [ttlSeconds]
  // Same fixed-window increment as AiWsRateLimitService.RECORD_TURN_SCRIPT —
  // TTL set only on the increment that creates the key, so the window starts
  // at the identity's first upload and genuinely expires.
  private static readonly RECORD_UPLOAD_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  constructor(private readonly appRedis: AppRedisService) {
    this.appRedis.rateLimiter.defineCommand('aiAttachmentUploadRecord', {
      numberOfKeys: 1,
      lua: AiAttachmentStagingService.RECORD_UPLOAD_SCRIPT,
    });
  }

  /**
   * Admission control for the upload endpoint itself.
   *
   * Fails CLOSED, exactly like `AiWsRateLimitService` and for a stronger
   * reason: every accepted upload can trigger a paid vision call on an
   * endpoint no login stands in front of. With no limiter to consult, the
   * safe answer is "no".
   */
  async assertUploadAllowed(ownerSubject: string): Promise<void> {
    const key = `${cacheKeyPrefix()}ai:attach:rate:${this.hash(ownerSubject)}`;
    let count: number;
    try {
      count = await this.appRedis.rateLimiter.aiAttachmentUploadRecord(
        key,
        String(ATTACHMENT_UPLOAD_WINDOW_SECONDS),
      );
      this.degradedLog.recordSuccess();
    } catch (err) {
      this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Attachment uploads are temporarily unavailable',
      });
    }
    if (count > ATTACHMENT_UPLOAD_MAX_PER_WINDOW) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many files uploaded — wait before attaching another',
      });
    }
  }

  /** Parks a freshly uploaded descriptor for the turn that will claim it. */
  async stage(
    ownerSubject: string,
    attachment: ConversationAttachment,
  ): Promise<void> {
    try {
      await this.appRedis.application.set(
        this.keyFor(ownerSubject, attachment.id),
        JSON.stringify(attachment),
        'EX',
        ATTACHMENT_STAGING_TTL_SECONDS,
      );
    } catch (err) {
      this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Attachment uploads are temporarily unavailable',
      });
    }
  }

  /**
   * Drops a staged attachment. Returns whether anything was actually removed,
   * so the caller can answer a delete for an unknown id the same way it
   * answers one for another guest's id — see the controller.
   */
  async discard(ownerSubject: string, id: string): Promise<boolean> {
    try {
      const removed = await this.appRedis.application.del(
        this.keyFor(ownerSubject, id),
      );
      return removed > 0;
    } catch (err) {
      this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
      return false;
    }
  }

  /**
   * Claims staged attachments for a conversation.
   *
   * `alreadyBound` are the ids this conversation's session already holds — a
   * follow-up question about the same file must NOT be reported as missing
   * just because its single-use staging key is long gone.
   */
  async redeem(
    ownerSubject: string,
    ids: readonly string[],
    alreadyBound: readonly string[] = [],
  ): Promise<AttachmentRedemption> {
    const bound = new Set(alreadyBound);
    const wanted = [...new Set(ids)].filter((id) => !bound.has(id));
    const attachments: ConversationAttachment[] = [];
    const missing: string[] = [];

    for (const id of wanted) {
      let raw: string | null = null;
      try {
        // Single-use: the descriptor is read and deleted atomically, so the
        // same upload cannot be bound to two conversations and a captured id
        // cannot be replayed.
        raw = await this.appRedis.application.getdel(this.keyFor(ownerSubject, id));
        this.degradedLog.recordSuccess();
      } catch (err) {
        this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
        // A Redis fault must not kill the turn — the visitor still asked a
        // question. It is reported as missing, which is the truth.
        missing.push(id);
        continue;
      }
      if (!raw) {
        missing.push(id);
        continue;
      }
      const parsed = this.parse(raw);
      if (parsed) attachments.push(parsed);
      else missing.push(id);
    }
    return { attachments, missing };
  }

  /**
   * Defensive parse. The value was written by this service, but a malformed
   * or truncated blob must degrade to "missing" rather than put an unchecked
   * object into the model's prompt.
   */
  private parse(raw: string): ConversationAttachment | null {
    try {
      const value = JSON.parse(raw) as Partial<ConversationAttachment>;
      if (
        typeof value?.id !== 'string' ||
        typeof value.promptName !== 'string' ||
        typeof value.text !== 'string' ||
        (value.status !== 'ready' && value.status !== 'unreadable')
      ) {
        return null;
      }
      return value as ConversationAttachment;
    } catch {
      return null;
    }
  }

  private keyFor(ownerSubject: string, id: string): string {
    return `${cacheKeyPrefix()}ai:attach:${this.hash(ownerSubject)}:${id}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
