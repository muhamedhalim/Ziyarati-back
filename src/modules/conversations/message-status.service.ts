import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { Message } from '../../entities/Conversations/Message';
import { MessageStatusLog } from '../../entities/Conversations/MessageStatusLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { MESSAGE_STATUS, MESSAGE_STATUSES } from './conversation.constants';

/**
 * Forward-progress rank for the happy path SENT → DELIVERED → READ. FAILED is a
 * terminal side-state (rank 0) that may be recorded regardless of progress.
 */
const STATUS_RANK: Record<string, number> = {
  [MESSAGE_STATUS.SENT]: 1,
  [MESSAGE_STATUS.DELIVERED]: 2,
  [MESSAGE_STATUS.READ]: 3,
};

/**
 * Append-only message delivery status log (SENT → DELIVERED → READ, or FAILED).
 *
 * Tenant isolation: logs are stamped with the tenant and read via the
 * tenant-scoped message.
 */
@Injectable()
export class MessageStatusService {
  constructor(
    @InjectRepository(MessageStatusLog)
    private readonly statusLogs: Repository<MessageStatusLog>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
  ) {}

  /**
   * Appends a status entry. Can run inside a caller's transaction (pass the
   * EntityManager) or standalone. Validates the message belongs to the tenant
   * when run standalone.
   */
  async append(
    tenantId: string,
    messageId: string,
    status: string,
    manager?: EntityManager,
  ): Promise<MessageStatusLog> {
    if (!MESSAGE_STATUSES.includes(status as never)) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: 'Invalid message status' });
    }
    const repo = manager ? manager.getRepository(MessageStatusLog) : this.statusLogs;
    const row = repo.create({
      message: { id: messageId } as Message,
      tenant: { id: tenantId } as Tenant,
      status,
    });
    return repo.save(row);
  }

  /** Records that a message was read (READ). */
  async markRead(tenantId: string, messageId: string): Promise<MessageStatusLog> {
    return this.transition(tenantId, messageId, MESSAGE_STATUS.READ);
  }

  /** Records a delivery (DELIVERED) — webhook/seam driven. */
  async markDelivered(tenantId: string, messageId: string): Promise<MessageStatusLog> {
    return this.transition(tenantId, messageId, MESSAGE_STATUS.DELIVERED);
  }

  /** Records a failed delivery (FAILED) — webhook/seam driven; retry handled upstream. */
  async markFailed(tenantId: string, messageId: string): Promise<MessageStatusLog> {
    return this.transition(tenantId, messageId, MESSAGE_STATUS.FAILED);
  }

  /**
   * Append a status only if it is a valid FORWARD transition, making delivery
   * status monotonic and idempotent under out-of-order, at-least-once webhooks:
   *  - the same status arriving twice is a no-op (returns the existing latest);
   *  - a stale/earlier status (e.g. DELIVERED after READ) is ignored, so READ is
   *    never regressed;
   *  - FAILED is always recordable (terminal side-state).
   * A DB-level UNIQUE(messageId, status) (see ConversationsSchemaBootstrap) is the
   * backstop against the read-then-write race between concurrent webhooks.
   */
  private async transition(
    tenantId: string,
    messageId: string,
    next: string,
  ): Promise<MessageStatusLog> {
    await this.assertMessage(tenantId, messageId);

    const latest = await this.statusLogs.findOne({
      where: { message: { id: messageId }, tenant: { id: tenantId } },
      order: { created_at: 'DESC' },
    });

    if (next !== MESSAGE_STATUS.FAILED && latest) {
      const currentRank = STATUS_RANK[latest.status] ?? 0;
      const nextRank = STATUS_RANK[next] ?? 0;
      // Same or earlier state → no-op (idempotent), never regress.
      if (nextRank <= currentRank) return latest;
    }

    return this.append(tenantId, messageId, next);
  }

  /** Full status history (chronological) for a message. */
  async history(tenantId: string, messageId: string): Promise<MessageStatusLog[]> {
    await this.assertMessage(tenantId, messageId);
    return this.statusLogs.find({
      where: { message: { id: messageId }, tenant: { id: tenantId } },
      order: { created_at: 'ASC' },
    });
  }

  /** Latest status (derived current state) for a message, or null. */
  async current(tenantId: string, messageId: string): Promise<string | null> {
    await this.assertMessage(tenantId, messageId);
    const latest = await this.statusLogs.findOne({
      where: { message: { id: messageId }, tenant: { id: tenantId } },
      order: { created_at: 'DESC' },
    });
    return latest?.status ?? null;
  }

  private async assertMessage(tenantId: string, messageId: string): Promise<void> {
    if (!(await this.messages.exists({ where: { id: messageId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Message not found' });
    }
  }
}
