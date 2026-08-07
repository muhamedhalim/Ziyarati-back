import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsOrder, FindOptionsWhere, ILike, Repository } from 'typeorm';

import { SupportTicket } from '../../entities/SupportTickets/SupportTicket';
import { SupportTicketEvent } from '../../entities/SupportTickets/SupportTicketEvent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';
import { StorageService } from '../storage/storage.service';

import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { QueryMyTicketsDto } from './dto/query-my-tickets.dto';
import { QuerySupportTicketsDto } from './dto/query-support-tickets.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { UpdateTicketPriorityDto } from './dto/update-ticket-priority.dto';
import { AddTicketNoteDto } from './dto/add-ticket-note.dto';
import { TERMINAL_TICKET_STATUSES } from './support-tickets.constants';

/** Minimal actor identity — snapshotted onto tickets/events so history survives user deletion. */
export interface TicketActor {
  id: string;
  name?: string | null;
  email?: string | null;
  /** 'clinic' for a tenant-side actor, or an RBAC role slug (e.g. 'super_admin') for a platform one. */
  role?: string;
}

/**
 * Support Tickets domain service.
 *
 * Tenant isolation: every tenant-facing method takes `tenantId` and filters
 * `where: { tenant: { id: tenantId } }`; the platform (admin) methods have no
 * tenant filter by default (only an optional explicit one from a super-admin
 * query param). Creator/actor identity is snapshotted as plain columns at
 * write time (`created_by_name`, `actor_name`, ...) specifically so list/detail
 * reads never need to join `users` — avoids N+1 without any caching layer.
 */
@Injectable()
export class SupportTicketService {
  constructor(
    @InjectRepository(SupportTicket)
    private readonly tickets: Repository<SupportTicket>,
    @InjectRepository(SupportTicketEvent)
    private readonly events: Repository<SupportTicketEvent>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  // ─────────────────────────────── Tenant side ────────────────────────────────

  async create(
    tenantId: string,
    actor: TicketActor,
    dto: CreateSupportTicketDto,
  ): Promise<SupportTicket> {
    let attachment: Pick<
      SupportTicket,
      'attachment_key' | 'attachment_filename' | 'attachment_mime_type' | 'attachment_size'
    > = {
      attachment_key: undefined,
      attachment_filename: undefined,
      attachment_mime_type: undefined,
      attachment_size: undefined,
    };

    if (dto.attachmentKey) {
      // Never trust a client-supplied key blindly: it must live under this
      // tenant's prefix AND actually exist in the bucket (mirrors
      // TenantVerificationService's upload-then-attach flow).
      this.storage.assertKeyBelongsToTenant(dto.attachmentKey, tenantId);
      const exists = await this.storage.objectExists(dto.attachmentKey);
      if (!exists) {
        throw new AppError(ErrorCode.BAD_REQUEST, {
          message: 'Attachment not found in storage. Upload it again.',
        });
      }
      attachment = { ...attachment, attachment_key: dto.attachmentKey };
    }

    const ticket = this.tickets.create({
      tenant: { id: tenantId } as Tenant,
      ticket_number: await this.nextTicketNumber(),
      subject: dto.subject,
      category: dto.category,
      priority: dto.priority,
      status: 'open',
      description: dto.description,
      ...attachment,
      preferred_contact_time: dto.preferredContactTime ? new Date(dto.preferredContactTime) : undefined,
      createdBy: { id: actor.id } as User,
      created_by_name: actor.name ?? undefined,
      created_by_email: actor.email ?? undefined,
    });
    return this.tickets.save(ticket);
  }

  async listForTenant(tenantId: string, query: QueryMyTicketsDto) {
    const base: FindOptionsWhere<SupportTicket> = { tenant: { id: tenantId } };
    if (query.status) base.status = query.status;
    if (query.category) base.category = query.category;
    if (query.priority) base.priority = query.priority;

    let where: FindOptionsWhere<SupportTicket> | FindOptionsWhere<SupportTicket>[] = base;
    if (query.search) {
      const term = `%${query.search}%`;
      where = [
        { ...base, subject: ILike(term) },
        { ...base, ticket_number: ILike(term) },
      ];
    }

    const [data, total] = await this.tickets.findAndCount({
      where,
      order: { [query.sortBy]: query.sortOrder } as FindOptionsOrder<SupportTicket>,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map((t) => this.toTenantSummary(t)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async getForTenant(tenantId: string, id: string) {
    const ticket = await this.tickets.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!ticket) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Ticket not found' });
    }
    const events = await this.events.find({
      where: { ticket: { id }, internal_only: false },
      order: { created_at: 'ASC' },
    });
    return {
      ...this.toTenantSummary(ticket),
      description: ticket.description,
      attachmentUrl: await this.resolveAttachmentUrl(ticket, tenantId),
      history: events.map((e) => this.toEventView(e)),
    };
  }

  /**
   * Clinic confirms the issue is resolved and closes its own ticket. Only
   * valid from `resolved` (support must resolve first — a clinic can never
   * resolve or skip straight to closed) and only for the caller's own
   * tenant; `closed_at` is always backend-generated, never client-supplied.
   */
  async closeOwnTicket(tenantId: string, actor: TicketActor, id: string) {
    const ticket = await this.tickets.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!ticket) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Ticket not found' });
    }
    if (ticket.status !== 'resolved') {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Ticket must be resolved before it can be closed.',
      });
    }
    const from = ticket.status;
    ticket.status = 'closed';
    ticket.closed_at = ticket.closed_at ?? new Date();
    await this.tickets.save(ticket);
    await this.recordEvent({
      ticketId: id,
      type: 'STATUS_CHANGED',
      fromValue: from,
      toValue: 'closed',
      internalOnly: false,
      actor,
    });
    return this.getForTenant(tenantId, id);
  }

  // ─────────────────────────────── Platform side ──────────────────────────────

  async listForAdmin(query: QuerySupportTicketsDto) {
    const base: FindOptionsWhere<SupportTicket> = {};
    if (query.tenantId) base.tenant = { id: query.tenantId };
    if (query.status) base.status = query.status;
    if (query.category) base.category = query.category;
    if (query.priority) base.priority = query.priority;

    let where: FindOptionsWhere<SupportTicket> | FindOptionsWhere<SupportTicket>[] = base;
    if (query.search) {
      const term = `%${query.search}%`;
      where = [
        { ...base, subject: ILike(term) },
        { ...base, ticket_number: ILike(term) },
      ];
    }

    // Single query with a JOIN on `tenant` (relations, not a second round-trip);
    // creator identity is read from the snapshot columns, so no `users` join at
    // all is needed for the list.
    const [data, total] = await this.tickets.findAndCount({
      where,
      relations: { tenant: true },
      order: { [query.sortBy]: query.sortOrder } as FindOptionsOrder<SupportTicket>,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map((t) => this.toAdminSummary(t)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async getForAdmin(id: string) {
    const ticket = await this.tickets.findOne({ where: { id }, relations: { tenant: true } });
    if (!ticket) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Ticket not found' });
    }
    const events = await this.events.find({
      where: { ticket: { id } },
      order: { created_at: 'ASC' },
    });
    return {
      ...this.toAdminSummary(ticket),
      description: ticket.description,
      attachmentUrl: await this.resolveAttachmentUrl(ticket, ticket.tenant.id),
      history: events.filter((e) => !e.internal_only).map((e) => this.toEventView(e)),
      notes: events.filter((e) => e.internal_only).map((e) => this.toEventView(e)),
    };
  }

  /** Aggregate KPI counts for the super-admin dashboard — one query, no N+1. */
  async kpis() {
    const [row] = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')::int AS open,
        COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
        COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('resolved', 'closed'))::int AS urgent
      FROM support_tickets
    `);
    return {
      open: Number(row?.open ?? 0),
      inProgress: Number(row?.in_progress ?? 0),
      resolved: Number(row?.resolved ?? 0),
      urgent: Number(row?.urgent ?? 0),
    };
  }

  async updateStatus(id: string, actor: TicketActor, dto: UpdateTicketStatusDto) {
    const ticket = await this.findAnyOrThrow(id);
    if (ticket.status === dto.status) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Ticket is already "${dto.status}"`,
      });
    }
    const from = ticket.status;
    ticket.status = dto.status;

    if (dto.status === 'resolved') {
      ticket.resolved_at = ticket.resolved_at ?? new Date();
    } else if (dto.status === 'closed') {
      const now = new Date();
      ticket.closed_at = now;
      ticket.resolved_at = ticket.resolved_at ?? now;
    } else {
      // Reopening (open / in_progress / waiting_for_tenant) clears both.
      ticket.resolved_at = null;
      ticket.closed_at = null;
    }

    await this.tickets.save(ticket);
    await this.recordEvent({
      ticketId: id,
      type: 'STATUS_CHANGED',
      fromValue: from,
      toValue: dto.status,
      note: dto.note,
      internalOnly: false,
      actor,
    });
    return this.getForAdmin(id);
  }

  async updatePriority(id: string, actor: TicketActor, dto: UpdateTicketPriorityDto) {
    const ticket = await this.findAnyOrThrow(id);
    if (ticket.priority === dto.priority) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Ticket priority is already "${dto.priority}"`,
      });
    }
    const from = ticket.priority;
    ticket.priority = dto.priority;
    await this.tickets.save(ticket);
    await this.recordEvent({
      ticketId: id,
      type: 'PRIORITY_CHANGED',
      fromValue: from,
      toValue: dto.priority,
      internalOnly: false,
      actor,
    });
    return this.getForAdmin(id);
  }

  async addNote(id: string, actor: TicketActor, dto: AddTicketNoteDto) {
    await this.findAnyOrThrow(id);
    await this.recordEvent({
      ticketId: id,
      type: 'NOTE_ADDED',
      note: dto.note,
      internalOnly: true,
      actor,
    });
    return this.getForAdmin(id);
  }

  // ─────────────────────────────── Internals ──────────────────────────────────

  private async findAnyOrThrow(id: string): Promise<SupportTicket> {
    const ticket = await this.tickets.findOne({ where: { id } });
    if (!ticket) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Ticket not found' });
    }
    return ticket;
  }

  private async nextTicketNumber(): Promise<string> {
    const [row] = await this.dataSource.query(
      `SELECT nextval('support_ticket_number_seq') AS n`,
    );
    return `SUP-${String(row.n).padStart(6, '0')}`;
  }

  private async resolveAttachmentUrl(
    ticket: SupportTicket,
    tenantId: string,
  ): Promise<string | null> {
    if (!ticket.attachment_key) return null;
    return this.storage.getSignedDownloadUrl(ticket.attachment_key, tenantId);
  }

  private async recordEvent(input: {
    ticketId: string;
    type: 'STATUS_CHANGED' | 'PRIORITY_CHANGED' | 'NOTE_ADDED';
    fromValue?: string;
    toValue?: string;
    note?: string;
    internalOnly: boolean;
    actor: TicketActor;
  }): Promise<void> {
    const event = this.events.create({
      ticket: { id: input.ticketId } as SupportTicket,
      type: input.type,
      from_value: input.fromValue,
      to_value: input.toValue,
      note: input.note,
      internal_only: input.internalOnly,
      actor: { id: input.actor.id } as User,
      actor_name: input.actor.name ?? undefined,
      actor_role: input.actor.role ?? undefined,
    });
    await this.events.save(event);
  }

  private toTenantSummary(t: SupportTicket) {
    return {
      id: t.id,
      ticketNumber: t.ticket_number,
      subject: t.subject,
      category: t.category,
      priority: t.priority,
      status: t.status,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      resolvedAt: t.resolved_at ?? null,
      closedAt: t.closed_at ?? null,
      preferredContactTime: t.preferred_contact_time ?? null,
      hasAttachment: !!t.attachment_key,
      attachmentFilename: t.attachment_filename ?? null,
    };
  }

  private toAdminSummary(t: SupportTicket) {
    return {
      ...this.toTenantSummary(t),
      tenant: t.tenant ? { id: t.tenant.id, name: t.tenant.name } : null,
      createdBy: { name: t.created_by_name ?? null, email: t.created_by_email ?? null },
      isTerminal: TERMINAL_TICKET_STATUSES.includes(t.status as (typeof TERMINAL_TICKET_STATUSES)[number]),
    };
  }

  private toEventView(e: SupportTicketEvent) {
    return {
      id: e.id,
      type: e.type,
      fromValue: e.from_value ?? null,
      toValue: e.to_value ?? null,
      note: e.note ?? null,
      actorName: e.actor_name ?? null,
      actorRole: e.actor_role ?? null,
      createdAt: e.created_at,
    };
  }
}
