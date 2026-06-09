import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateHandoverRequestDto } from './dto/create-handover-request.dto';
import { UpdateHandoverRequestDto } from './dto/update-handover-request.dto';
import { AssignHandoverDto } from './dto/assign-handover.dto';
import { HandoverRequestFilterDto } from './dto/handover-request-filter.dto';
import {
  AI_CONVERSATION_STATUS,
  HANDOVER_STATUS,
  TERMINAL_HANDOVER_STATUSES,
  HandoverStatus,
} from './ai.constants';

/**
 * Human handover requests — escalate an AI/messaging conversation to staff.
 *
 * Schema note: `handover_requests.conversation` is the messaging `Conversation`
 * (required). Lifecycle (free varchar status): PENDING → ASSIGNED → ACCEPTED →
 * RESOLVED, or → REJECTED. `resolved_at` is set on RESOLVED/REJECTED.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; the
 * conversation and assignee are validated against the tenant.
 */
@Injectable()
export class HandoverRequestService {
  constructor(
    @InjectRepository(HandoverRequest)
    private readonly handovers: Repository<HandoverRequest>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async create(tenantId: string, dto: CreateHandoverRequestDto): Promise<HandoverRequest> {
    await this.assertConversation(tenantId, dto.conversationId);

    const handover = await this.handovers.save(
      this.handovers.create({
        tenant: { id: tenantId } as Tenant,
        conversation: { id: dto.conversationId } as Conversation,
        reason: dto.reason,
        status: HANDOVER_STATUS.PENDING,
      }),
    );

    // Flip the linked AI conversation (if provided) to HANDED_OVER.
    if (dto.aiConversationId) {
      const aiConv = await this.aiConversations.findOne({
        where: { id: dto.aiConversationId, tenant: { id: tenantId } },
      });
      if (aiConv) {
        aiConv.status = AI_CONVERSATION_STATUS.HANDED_OVER;
        await this.aiConversations.save(aiConv);
      }
    }

    return this.findOne(tenantId, handover.id);
  }

  async findAll(tenantId: string, filter: HandoverRequestFilterDto) {
    const where: FindOptionsWhere<HandoverRequest> = { tenant: { id: tenantId } };
    if (filter.status) where.status = filter.status;
    if (filter.assignedToUserId) where.assigned_to = { id: filter.assignedToUserId };

    const [data, total] = await this.handovers.findAndCount({
      where,
      relations: { conversation: true, assigned_to: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<HandoverRequest> {
    const handover = await this.handovers.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { conversation: true, assigned_to: true },
    });
    if (!handover) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Handover request not found' });
    return handover;
  }

  async update(tenantId: string, id: string, dto: UpdateHandoverRequestDto): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    if (dto.reason !== undefined) handover.reason = dto.reason;
    return this.handovers.save(handover);
  }

  /** PENDING → ASSIGNED (sets the assignee). */
  async assign(tenantId: string, id: string, dto: AssignHandoverDto): Promise<HandoverRequest> {
    if (!(await this.users.exists({ where: { id: dto.assignedToUserId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Assignee not found in this tenant' });
    }
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    handover.assigned_to = { id: dto.assignedToUserId } as User;
    handover.status = HANDOVER_STATUS.ASSIGNED;
    await this.handovers.save(handover);
    return this.findOne(tenantId, id);
  }

  /** ASSIGNED → ACCEPTED. */
  async accept(tenantId: string, id: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    if (handover.status !== HANDOVER_STATUS.ASSIGNED) {
      throw new AppError(ErrorCode.CONFLICT, { message: `Cannot accept from status "${handover.status}"` });
    }
    handover.status = HANDOVER_STATUS.ACCEPTED;
    await this.handovers.save(handover);
    return this.findOne(tenantId, id);
  }

  /** → RESOLVED (terminal; sets resolved_at). */
  async resolve(tenantId: string, id: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    handover.status = HANDOVER_STATUS.RESOLVED;
    handover.resolved_at = new Date();
    await this.handovers.save(handover);
    return this.findOne(tenantId, id);
  }

  /** → REJECTED (terminal; sets resolved_at). */
  async reject(tenantId: string, id: string, reason?: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    handover.status = HANDOVER_STATUS.REJECTED;
    if (reason) handover.reason = reason;
    handover.resolved_at = new Date();
    await this.handovers.save(handover);
    return this.findOne(tenantId, id);
  }

  private assertNotTerminal(status: string): void {
    if (TERMINAL_HANDOVER_STATUSES.includes(status as HandoverStatus)) {
      throw new AppError(ErrorCode.CONFLICT, { message: `Handover is already ${status}` });
    }
  }

  private async assertConversation(tenantId: string, conversationId: string): Promise<void> {
    if (!(await this.conversations.exists({ where: { id: conversationId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Conversation not found in this tenant' });
    }
  }
}
