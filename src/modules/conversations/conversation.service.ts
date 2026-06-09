import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { ConversationParticipant } from '../../entities/Conversations/ConversationParticipant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { ConversationFilterDto } from './dto/conversation-filter.dto';
import { CONVERSATION_STATUS } from './conversation.constants';

/**
 * Conversation lifecycle (create / list / get / update / assign / archive /
 * delete).
 *
 * Tenant isolation: every query joins/filters `tenant.id = tenantId`; every
 * create stamps the tenant; referenced branch/customer/account/assignee are
 * re-validated against the tenant. Archive = ARCHIVED status (no deleted_at
 * column); delete = hard delete (CASCADE removes participants/messages).
 */
@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async create(tenantId: string, dto: CreateConversationDto): Promise<Conversation> {
    if (dto.branchId) await this.assertBranch(tenantId, dto.branchId);
    if (dto.customerId) await this.assertCustomer(tenantId, dto.customerId);
    if (dto.whatsappAccountId) await this.assertAccount(tenantId, dto.whatsappAccountId);
    if (dto.assignedToUserId) await this.assertUser(tenantId, dto.assignedToUserId);

    const status =
      dto.status ??
      (dto.assignedToUserId ? CONVERSATION_STATUS.ASSIGNED : CONVERSATION_STATUS.OPEN);

    const conversation = this.conversations.create({
      tenant: { id: tenantId } as Tenant,
      branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
      customer: dto.customerId ? ({ id: dto.customerId } as Customer) : undefined,
      whatsapp_account: dto.whatsappAccountId
        ? ({ id: dto.whatsappAccountId } as WhatsappAccount)
        : undefined,
      assigned_to: dto.assignedToUserId ? ({ id: dto.assignedToUserId } as User) : undefined,
      type: dto.type,
      status,
    });
    const saved = await this.conversations.save(conversation);
    return this.findOne(tenantId, saved.id);
  }

  async findAll(tenantId: string, filter: ConversationFilterDto) {
    // Resolve the participant filter to conversation ids (avoids raw FK SQL).
    let participantConversationIds: string[] | undefined;
    if (filter.participantUserId) {
      const parts = await this.participants.find({
        where: { user: { id: filter.participantUserId } },
        relations: { conversation: true },
      });
      participantConversationIds = parts.map((p) => p.conversation.id);
      if (participantConversationIds.length === 0) {
        return { data: [], total: 0, page: filter.page, limit: filter.limit };
      }
    }

    const qb = this.scoped(tenantId)
      .leftJoinAndSelect('c.branch', 'branch')
      .leftJoinAndSelect('c.customer', 'customer')
      .leftJoinAndSelect('c.assigned_to', 'assignee');

    if (filter.status) qb.andWhere('c.status = :status', { status: filter.status });
    if (filter.type) qb.andWhere('c.type = :type', { type: filter.type });
    if (filter.assignedToUserId) qb.andWhere('assignee.id = :aid', { aid: filter.assignedToUserId });
    if (filter.customerId) qb.andWhere('customer.id = :cid', { cid: filter.customerId });
    if (filter.branchId) qb.andWhere('branch.id = :bid', { bid: filter.branchId });
    if (filter.from) qb.andWhere('c.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('c.created_at < :to', { to: new Date(filter.to) });
    if (participantConversationIds) qb.andWhere({ id: In(participantConversationIds) });

    const [data, total] = await qb
      .orderBy('c.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('c.created_at', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<Conversation> {
    const conversation = await this.conversations.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { branch: true, customer: true, whatsapp_account: true, assigned_to: true },
    });
    if (!conversation) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Conversation not found' });
    }
    return conversation;
  }

  async update(tenantId: string, id: string, dto: UpdateConversationDto): Promise<Conversation> {
    const conversation = await this.findOne(tenantId, id);
    if (dto.branchId !== undefined) {
      if (dto.branchId) {
        await this.assertBranch(tenantId, dto.branchId);
        conversation.branch = { id: dto.branchId } as Branch;
      } else {
        conversation.branch = undefined;
      }
    }
    if (dto.type !== undefined) conversation.type = dto.type;
    if (dto.status !== undefined) conversation.status = dto.status;
    await this.conversations.save(conversation);
    return this.findOne(tenantId, id);
  }

  async assign(tenantId: string, id: string, userId: string): Promise<Conversation> {
    await this.assertUser(tenantId, userId);
    const conversation = await this.findOne(tenantId, id);
    conversation.assigned_to = { id: userId } as User;
    conversation.status = CONVERSATION_STATUS.ASSIGNED;
    await this.conversations.save(conversation);
    return this.findOne(tenantId, id);
  }

  async archive(tenantId: string, id: string): Promise<Conversation> {
    return this.setStatus(tenantId, id, CONVERSATION_STATUS.ARCHIVED);
  }

  async unarchive(tenantId: string, id: string): Promise<Conversation> {
    return this.setStatus(tenantId, id, CONVERSATION_STATUS.OPEN);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOne(tenantId, id);
    await this.conversations.delete({ id });
  }

  /** Verifies the conversation belongs to the tenant; returns it (used by sibling services). */
  async getOwned(tenantId: string, id: string): Promise<Conversation> {
    return this.findOne(tenantId, id);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private scoped(tenantId: string): SelectQueryBuilder<Conversation> {
    return this.conversations
      .createQueryBuilder('c')
      .leftJoin('c.tenant', 'tenant')
      .where('tenant.id = :tenantId', { tenantId });
  }

  private async setStatus(tenantId: string, id: string, status: string): Promise<Conversation> {
    const conversation = await this.findOne(tenantId, id);
    conversation.status = status;
    await this.conversations.save(conversation);
    return this.findOne(tenantId, id);
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    if (!(await this.branches.exists({ where: { id: branchId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Branch not found in this tenant' });
    }
  }
  private async assertCustomer(tenantId: string, customerId: string): Promise<void> {
    if (!(await this.customers.exists({ where: { id: customerId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Customer not found in this tenant' });
    }
  }
  private async assertAccount(tenantId: string, accountId: string): Promise<void> {
    if (!(await this.accounts.exists({ where: { id: accountId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'WhatsApp account not found in this tenant' });
    }
  }
  private async assertUser(tenantId: string, userId: string): Promise<void> {
    if (!(await this.users.exists({ where: { id: userId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'User not found in this tenant' });
    }
  }
}
