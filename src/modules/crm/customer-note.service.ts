import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerNote } from '../../entities/CRM/CustomerNote';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AppError, ErrorCode } from '../../common/errors';

import { CustomerService } from './customer.service';
import { CreateCustomerNoteDto } from './dto/create-customer-note.dto';
import { UpdateCustomerNoteDto } from './dto/update-customer-note.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';

/**
 * Internal (staff-only) customer notes (1:N). Tenant-scoped via the `tenant`
 * relation; the parent customer is verified tenant-owned first. The authoring
 * user is recorded for an audit-friendly trail (`user`, `created_at`).
 */
@Injectable()
export class CustomerNoteService {
  constructor(
    @InjectRepository(CustomerNote)
    private readonly notes: Repository<CustomerNote>,
    private readonly customers: CustomerService,
  ) {}

  async add(
    tenantId: string,
    customerId: string,
    dto: CreateCustomerNoteDto,
    userId?: string,
    conversationId?: string,
  ): Promise<CustomerNote> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    return this.notes.save(
      this.notes.create({
        customer: { id: customerId } as Customer,
        tenant: { id: tenantId } as Tenant,
        user: userId ? ({ id: userId } as User) : undefined,
        conversation: conversationId ? ({ id: conversationId } as Conversation) : undefined,
        content: dto.content,
      }),
    );
  }

  /** Internal notes attached to a specific Live Agent Handover conversation. */
  async listByConversation(tenantId: string, conversationId: string): Promise<CustomerNote[]> {
    return this.notes.find({
      where: { conversation: { id: conversationId }, tenant: { id: tenantId } },
      relations: { user: true },
      order: { created_at: 'DESC' },
    });
  }

  async update(
    tenantId: string,
    customerId: string,
    noteId: string,
    dto: UpdateCustomerNoteDto,
  ): Promise<CustomerNote> {
    const note = await this.findOneOrThrow(tenantId, customerId, noteId);
    if (dto.content !== undefined) note.content = dto.content;
    return this.notes.save(note);
  }

  async remove(tenantId: string, customerId: string, noteId: string) {
    const note = await this.findOneOrThrow(tenantId, customerId, noteId);
    await this.notes.remove(note);
    return { id: noteId, deleted: true };
  }

  async list(
    tenantId: string,
    customerId: string,
    query: PaginationQueryDto,
  ) {
    await this.customers.findOneOrThrow(tenantId, customerId);
    const [data, total] = await this.notes.findAndCount({
      where: { customer: { id: customerId }, tenant: { id: tenantId } },
      relations: { user: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  private async findOneOrThrow(
    tenantId: string,
    customerId: string,
    noteId: string,
  ): Promise<CustomerNote> {
    const note = await this.notes.findOne({
      where: { id: noteId, customer: { id: customerId }, tenant: { id: tenantId } },
    });
    if (!note) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Note not found' });
    }
    return note;
  }
}
