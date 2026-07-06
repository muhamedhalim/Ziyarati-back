import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FindOptionsWhere, Repository } from 'typeorm';

import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Message } from '../../entities/Conversations/Message';
import { CustomerNote } from '../../entities/CRM/CustomerNote';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { PERMISSION } from '../../rbac/rbac.constants';
import { CONVERSATION_OWNER_TYPE, CONVERSATION_STATUS, SENDER_TYPE } from '../conversations/conversation.constants';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { CustomerNoteService } from '../crm/customer-note.service';
import { HandoverNoteDto } from './dto/handover-note.dto';

import { CreateHandoverRequestDto } from './dto/create-handover-request.dto';
import { UpdateHandoverRequestDto } from './dto/update-handover-request.dto';
import { AssignHandoverDto } from './dto/assign-handover.dto';
import { TransferHandoverDto } from './dto/transfer-handover.dto';
import { HandoverRequestFilterDto } from './dto/handover-request-filter.dto';
import {
  AI_CONVERSATION_STATUS,
  AI_MESSAGE_ROLE,
  HANDOVER_STATUS,
  TERMINAL_HANDOVER_STATUSES,
  HandoverStatus,
} from './ai.constants';
import {
  HandoverAcceptedEvent,
  HandoverAgentRepliedEvent,
  HandoverAssignedEvent,
  HandoverConversationClosedEvent,
  HandoverRejectedEvent,
  HandoverReleasedEvent,
  HandoverRequestedEvent,
  HandoverResolvedEvent,
  HandoverReturnedToAiEvent,
  HandoverTransferredEvent,
} from '../../events/handover.events';

/**
 * Human handover requests — escalate an AI/messaging conversation to staff.
 *
 * Schema note: `handover_requests.conversation` is the messaging `Conversation`
 * (required). Lifecycle (free varchar status): PENDING → ASSIGNED → ACCEPTED →
 * RESOLVED, or → REJECTED. `resolved_at` is set on RESOLVED/REJECTED.
 *
 * `Conversation.owner_type` (AI/HUMAN) + `AiConversation.status` (HANDED_OVER)
 * are the two flags every lifecycle method keeps in sync: the former drives the
 * Agent Inbox / timeline, the latter is what actually gates `AiExecutionService`
 * (see `AiOrchestratorService.prepare`). Domain events (EventEmitter2, global,
 * no module coupling) let the realtime gateway and notifications listener react
 * without HandoverRequestService importing either module — same acyclic pattern
 * as AppointmentEvents/WorkflowEventListener.
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
    @InjectRepository(AiMessage) private readonly aiMessages: Repository<AiMessage>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserRole) private readonly userRoles: Repository<UserRole>,
    private readonly emitter: EventEmitter2,
    private readonly timeline: ConversationExecutionService,
    private readonly notes: CustomerNoteService,
  ) {}

  async create(tenantId: string, dto: CreateHandoverRequestDto): Promise<HandoverRequest> {
    if (!dto.conversationId && !dto.aiConversationId) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'conversationId or aiConversationId is required',
      });
    }

    let conversationId = dto.conversationId;
    let aiConv: AiConversation | null = null;

    if (dto.aiConversationId) {
      aiConv = await this.aiConversations.findOne({
        where: { id: dto.aiConversationId, tenant: { id: tenantId } },
        relations: { conversation: true },
      });
      if (!aiConv) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI conversation not found in this tenant' });
      }
      if (!conversationId) {
        conversationId = aiConv.conversation?.id;
        if (!conversationId) {
          // Every channel (website widget, dashboard, WhatsApp) gets a real
          // Agent Inbox entry at the moment of handover, even if this AI
          // session never had one (e.g. an anonymous website chat).
          const created = await this.conversations.save(
            this.conversations.create({
              tenant: { id: tenantId } as Tenant,
              type: 'support',
              status: CONVERSATION_STATUS.OPEN,
            }),
          );
          conversationId = created.id;
          aiConv.conversation = created;
          await this.aiConversations.save(aiConv);
        }
      }
    } else {
      await this.assertConversation(tenantId, conversationId!);
    }

    const handover = await this.handovers.save(
      this.handovers.create({
        tenant: { id: tenantId } as Tenant,
        conversation: { id: conversationId } as Conversation,
        reason: dto.reason,
        status: HANDOVER_STATUS.PENDING,
      }),
    );

    // Flip both ownership flags together: AiConversation.status gates the AI
    // engine; Conversation.owner_type drives the Inbox/timeline.
    if (aiConv) {
      aiConv.status = AI_CONVERSATION_STATUS.HANDED_OVER;
      await this.aiConversations.save(aiConv);
    }
    await this.conversations.update(
      { id: conversationId },
      { owner_type: CONVERSATION_OWNER_TYPE.HUMAN, handover_reason: dto.reason },
    );

    this.emitter.emit(
      HandoverRequestedEvent.eventName,
      new HandoverRequestedEvent(tenantId, handover.id, conversationId!, dto.aiConversationId, dto.reason),
    );

    return this.findOne(tenantId, handover.id);
  }

  /**
   * The most recent handover request for a conversation (any status) — lets
   * the conversation view resolve the id it needs for accept/transfer/etc, and
   * the `aiConversationId` it needs to join the realtime room / send replies.
   */
  async findLatestForConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<(HandoverRequest & { aiConversationId: string | null }) | null> {
    const handover = await this.handovers.findOne({
      where: { conversation: { id: conversationId }, tenant: { id: tenantId } },
      relations: { conversation: true, assigned_to: true, transferred_from: true },
      order: { created_at: 'DESC' },
    });
    if (!handover) return null;
    const aiConversationId = (await this.findAiConversationId(tenantId, conversationId)) ?? null;
    return Object.assign(handover, { aiConversationId });
  }

  /**
   * Tenant users who may be assigned/transferred a handover — anyone holding
   * `ai.handover.manage` (not just clinical Staff profiles, which are for
   * bookable practitioners and don't cover Owner/Manager/Receptionist). Powers
   * the Transfer dialog's agent picker.
   */
  async listEligibleAgents(
    tenantId: string,
  ): Promise<Pick<User, 'id' | 'full_name' | 'email'>[]> {
    const rows = await this.userRoles.find({
      where: {
        user: { tenant: { id: tenantId }, is_active: true },
        role: { rolePermissions: { permission: { slug: PERMISSION.AI_HANDOVER_MANAGE } } },
      },
      relations: { user: true },
      // Never select password_hash — this only needs enough to label a picker.
      select: { user: { id: true, full_name: true, email: true } },
    });
    const byId = new Map<string, Pick<User, 'id' | 'full_name' | 'email'>>();
    for (const row of rows) byId.set(row.user.id, row.user);
    return [...byId.values()].sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
  }

  async findAll(tenantId: string, filter: HandoverRequestFilterDto) {
    const where: FindOptionsWhere<HandoverRequest> = { tenant: { id: tenantId } };
    if (filter.status) where.status = filter.status;
    if (filter.assignedToUserId) where.assigned_to = { id: filter.assignedToUserId };
    if (filter.conversationId) where.conversation = { id: filter.conversationId };

    const [data, total] = await this.handovers.findAndCount({
      where,
      relations: { conversation: true, assigned_to: true, transferred_from: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<HandoverRequest> {
    const handover = await this.handovers.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { conversation: true, assigned_to: true, transferred_from: true },
    });
    if (!handover) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Handover request not found' });
    return handover;
  }

  async update(tenantId: string, id: string, dto: UpdateHandoverRequestDto): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    if (dto.reason !== undefined) handover.reason = dto.reason;
    return this.handovers.save(handover);
  }

  /** PENDING → ASSIGNED (sets the assignee on both the request and the conversation). */
  async assign(tenantId: string, id: string, dto: AssignHandoverDto): Promise<HandoverRequest> {
    await this.assertUser(tenantId, dto.assignedToUserId);
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    handover.assigned_to = { id: dto.assignedToUserId } as User;
    handover.status = HANDOVER_STATUS.ASSIGNED;
    await this.handovers.save(handover);
    await this.conversations.update(
      { id: handover.conversation.id },
      { assigned_to: { id: dto.assignedToUserId } as User, assigned_at: new Date() },
    );

    this.emitter.emit(
      HandoverAssignedEvent.eventName,
      new HandoverAssignedEvent(tenantId, id, handover.conversation.id, dto.assignedToUserId),
    );
    return this.findOne(tenantId, id);
  }

  /** ASSIGNED → ACCEPTED. Only the assigned agent may accept (ownership check). */
  async accept(tenantId: string, id: string, userId: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    if (handover.status !== HANDOVER_STATUS.ASSIGNED) {
      throw new AppError(ErrorCode.CONFLICT, { message: `Cannot accept from status "${handover.status}"` });
    }
    if (handover.assigned_to && handover.assigned_to.id !== userId) {
      throw new AppError(ErrorCode.CONFLICT, { message: 'Only the assigned agent can accept this handover' });
    }
    handover.status = HANDOVER_STATUS.ACCEPTED;
    await this.handovers.save(handover);

    const aiConversationId = await this.findAiConversationId(tenantId, handover.conversation.id);
    this.emitter.emit(
      HandoverAcceptedEvent.eventName,
      new HandoverAcceptedEvent(tenantId, id, handover.conversation.id, userId, aiConversationId),
    );
    return this.findOne(tenantId, id);
  }

  /** Claims a PENDING/unassigned-ASSIGNED handover in one step (assign + accept). */
  async takeOver(tenantId: string, id: string, userId: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    if (handover.status === HANDOVER_STATUS.ACCEPTED && handover.assigned_to?.id !== userId) {
      throw new AppError(ErrorCode.CONFLICT, { message: 'This conversation is already being handled by another agent' });
    }
    handover.assigned_to = { id: userId } as User;
    handover.status = HANDOVER_STATUS.ACCEPTED;
    await this.handovers.save(handover);
    await this.conversations.update(
      { id: handover.conversation.id },
      { assigned_to: { id: userId } as User, assigned_at: new Date() },
    );

    const aiConversationId = await this.findAiConversationId(tenantId, handover.conversation.id);
    this.emitter.emit(
      HandoverAssignedEvent.eventName,
      new HandoverAssignedEvent(tenantId, id, handover.conversation.id, userId),
    );
    this.emitter.emit(
      HandoverAcceptedEvent.eventName,
      new HandoverAcceptedEvent(tenantId, id, handover.conversation.id, userId, aiConversationId),
    );
    return this.findOne(tenantId, id);
  }

  /** The assigned agent releases the conversation back to the Waiting queue. */
  async release(tenantId: string, id: string, userId: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    if (handover.assigned_to && handover.assigned_to.id !== userId) {
      throw new AppError(ErrorCode.CONFLICT, { message: 'Only the assigned agent can release this handover' });
    }
    handover.assigned_to = undefined;
    handover.status = HANDOVER_STATUS.PENDING;
    await this.handovers.save(handover);
    await this.conversations.update(
      { id: handover.conversation.id },
      { assigned_to: undefined, assigned_at: undefined },
    );

    this.emitter.emit(
      HandoverReleasedEvent.eventName,
      new HandoverReleasedEvent(tenantId, id, handover.conversation.id),
    );
    return this.findOne(tenantId, id);
  }

  /** Transfers an ACCEPTED/ASSIGNED handover to another agent (resolves the old request, opens a new one). */
  async transfer(tenantId: string, id: string, dto: TransferHandoverDto, fromUserId: string): Promise<HandoverRequest> {
    await this.assertUser(tenantId, dto.toUserId);
    const current = await this.findOne(tenantId, id);
    this.assertNotTerminal(current.status);

    current.status = HANDOVER_STATUS.RESOLVED;
    current.resolved_at = new Date();
    await this.handovers.save(current);

    const next = await this.handovers.save(
      this.handovers.create({
        tenant: { id: tenantId } as Tenant,
        conversation: { id: current.conversation.id } as Conversation,
        reason: dto.reason ?? `Transferred from a previous agent.`,
        status: HANDOVER_STATUS.ASSIGNED,
        assigned_to: { id: dto.toUserId } as User,
        transferred_from: { id: fromUserId } as User,
      }),
    );

    await this.conversations.increment({ id: current.conversation.id }, 'transfer_count', 1);
    await this.conversations.update(
      { id: current.conversation.id },
      { assigned_to: { id: dto.toUserId } as User, assigned_at: new Date() },
    );

    this.emitter.emit(
      HandoverTransferredEvent.eventName,
      new HandoverTransferredEvent(tenantId, next.id, current.conversation.id, fromUserId, dto.toUserId),
    );
    return this.findOne(tenantId, next.id);
  }

  /**
   * Returns the conversation to the AI. Resolves the handover request and
   * flips BOTH ownership flags back — `AiConversation.status = ACTIVE` (the
   * ONLY change AiExecutionService needs to resume answering) and
   * `Conversation.owner_type = AI`. No new conversation, no message loss: the
   * full mixed AI/human message history stays exactly as it was written.
   */
  async returnToAi(tenantId: string, id: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);

    const aiConv = await this.aiConversations.findOne({
      where: { conversation: { id: handover.conversation.id }, tenant: { id: tenantId } },
    });
    if (!aiConv) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This conversation has no linked AI conversation to resume',
      });
    }

    handover.status = HANDOVER_STATUS.RESOLVED;
    handover.resolved_at = new Date();
    await this.handovers.save(handover);

    aiConv.status = AI_CONVERSATION_STATUS.ACTIVE;
    await this.aiConversations.save(aiConv);
    await this.conversations.update(
      { id: handover.conversation.id },
      { owner_type: CONVERSATION_OWNER_TYPE.AI, released_at: new Date(), assigned_to: undefined },
    );

    this.emitter.emit(
      HandoverReturnedToAiEvent.eventName,
      new HandoverReturnedToAiEvent(tenantId, handover.conversation.id, aiConv.id),
    );
    return this.findOne(tenantId, id);
  }

  /** → RESOLVED (terminal; sets resolved_at). "Mark Resolved" agent action. */
  async resolve(tenantId: string, id: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    handover.status = HANDOVER_STATUS.RESOLVED;
    handover.resolved_at = new Date();
    await this.handovers.save(handover);

    this.emitter.emit(
      HandoverResolvedEvent.eventName,
      new HandoverResolvedEvent(tenantId, id, handover.conversation.id),
    );
    return this.findOne(tenantId, id);
  }

  /** → REJECTED (terminal; sets resolved_at). Releases the conversation back to the Waiting queue. */
  async reject(tenantId: string, id: string, reason?: string): Promise<HandoverRequest> {
    const handover = await this.findOne(tenantId, id);
    this.assertNotTerminal(handover.status);
    handover.status = HANDOVER_STATUS.REJECTED;
    if (reason) handover.reason = reason;
    handover.resolved_at = new Date();
    await this.handovers.save(handover);
    await this.conversations.update({ id: handover.conversation.id }, { assigned_to: undefined, assigned_at: undefined });

    this.emitter.emit(
      HandoverRejectedEvent.eventName,
      new HandoverRejectedEvent(tenantId, id, handover.conversation.id, reason),
    );
    return this.findOne(tenantId, id);
  }

  /** Closes the conversation (Agent action "Close"). Resolves any open handover on it. */
  async closeConversation(tenantId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.getOwnedConversation(tenantId, conversationId);
    conversation.status = CONVERSATION_STATUS.CLOSED;
    await this.conversations.save(conversation);

    const open = await this.handovers.findOne({
      where: { conversation: { id: conversationId }, tenant: { id: tenantId } },
      order: { created_at: 'DESC' },
    });
    if (open && !TERMINAL_HANDOVER_STATUSES.includes(open.status as HandoverStatus)) {
      open.status = HANDOVER_STATUS.RESOLVED;
      open.resolved_at = new Date();
      await this.handovers.save(open);
    }

    this.emitter.emit(
      HandoverConversationClosedEvent.eventName,
      new HandoverConversationClosedEvent(tenantId, conversationId),
    );
    return this.getOwnedConversation(tenantId, conversationId);
  }

  /** Reopens a CLOSED conversation (Agent action "Reopen"). */
  async reopenConversation(tenantId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.getOwnedConversation(tenantId, conversationId);
    conversation.status = conversation.assigned_to ? CONVERSATION_STATUS.ASSIGNED : CONVERSATION_STATUS.OPEN;
    return this.conversations.save(conversation);
  }

  /** Tenant-scoped ownership check reused by the reply/notes/inbox-adjacent endpoints. */
  async getOwnedConversation(tenantId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId, tenant: { id: tenantId } },
      relations: { customer: true, whatsapp_account: true, assigned_to: true, branch: true },
    });
    if (!conversation) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Conversation not found' });
    return conversation;
  }

  /** Marks the conversation as read by its assigned agent (Inbox "unread" indicator). */
  async markConversationRead(tenantId: string, conversationId: string): Promise<void> {
    await this.conversations.update(
      { id: conversationId, tenant: { id: tenantId } },
      { agent_last_read_at: new Date() },
    );
  }

  /**
   * A human agent replies while the conversation is HANDED_OVER. Persists into
   * BOTH stores (same pattern as the AI's own turn, see AiExecutionService):
   *  1. `ai_messages` (role: 'assistant', `agent_user_id` set) — so the message
   *     is part of the AI's own history for a future "Return to AI", with zero
   *     special-casing in the prompt-building code.
   *  2. The unified `messages` timeline (sender_type AGENT) via the EXISTING
   *     `ConversationExecutionService.sendMessage` — the same write path the
   *     REST Conversations API uses, so search/analytics/inbox all agree.
   *
   * Ownership check (Requirement #9, Conversation Locking): only the currently
   * assigned agent may reply — the assignment itself IS the lock, so two agents
   * can never both be replying to the same conversation at once.
   *
   * Returns the saved Message + the conversation (with customer/whatsapp_account
   * loaded) so the caller (HandoverChatService, ai-realtime module) can decide
   * whether to also dispatch over WhatsApp — that dispatch itself stays out of
   * AiModule since only the ai-realtime module may safely import WhatsappModule.
   */
  async sendAgentReply(
    tenantId: string,
    userId: string,
    aiConversationId: string,
    content: string,
  ): Promise<{ message: Message; conversation: Conversation }> {
    const aiConv = await this.aiConversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
      relations: { conversation: true },
    });
    if (!aiConv) throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI conversation not found' });
    if (aiConv.status !== AI_CONVERSATION_STATUS.HANDED_OVER) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Cannot reply as an agent — conversation is not handed over (status "${aiConv.status}")`,
      });
    }
    const conversationId = aiConv.conversation?.id;
    if (!conversationId) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI conversation has no linked conversation' });
    }
    const conversation = await this.getOwnedConversation(tenantId, conversationId);
    if (conversation.assigned_to && conversation.assigned_to.id !== userId) {
      throw new AppError(ErrorCode.CONFLICT, { message: 'This conversation is assigned to another agent' });
    }

    await this.aiMessages.save(
      this.aiMessages.create({
        ai_conversation_id: aiConversationId,
        tenant: { id: tenantId } as Tenant,
        role: AI_MESSAGE_ROLE.ASSISTANT,
        content,
        tokens_used: 0,
        agent_user_id: userId,
      }),
    );

    const message = await this.timeline.sendMessage(tenantId, userId, conversationId, {
      content,
      senderType: SENDER_TYPE.AGENT,
    });
    await this.markConversationRead(tenantId, conversationId);

    this.emitter.emit(
      HandoverAgentRepliedEvent.eventName,
      new HandoverAgentRepliedEvent(tenantId, conversationId, aiConversationId, userId, content),
    );

    return { message, conversation };
  }

  /** Adds an internal (staff-only) note — a first-class CRM note against the customer. */
  async addNote(tenantId: string, userId: string, conversationId: string, dto: HandoverNoteDto): Promise<CustomerNote> {
    const conversation = await this.getOwnedConversation(tenantId, conversationId);
    if (!conversation.customer) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This conversation has no customer profile — internal notes are unavailable',
      });
    }
    return this.notes.add(tenantId, conversation.customer.id, dto, userId, conversationId);
  }

  /** Internal notes for the conversation's Timeline panel (never customer-visible). */
  async listNotes(tenantId: string, conversationId: string): Promise<CustomerNote[]> {
    await this.getOwnedConversation(tenantId, conversationId);
    return this.notes.listByConversation(tenantId, conversationId);
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

  private async assertUser(tenantId: string, userId: string): Promise<void> {
    if (!(await this.users.exists({ where: { id: userId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Assignee not found in this tenant' });
    }
  }

  /** Best-effort lookup so realtime events can also reach the customer's own
   *  chat room (keyed by aiConversationId) — undefined when there is none. */
  private async findAiConversationId(tenantId: string, conversationId: string): Promise<string | undefined> {
    const aiConv = await this.aiConversations.findOne({
      where: { conversation: { id: conversationId }, tenant: { id: tenantId } },
    });
    return aiConv?.id;
  }
}
