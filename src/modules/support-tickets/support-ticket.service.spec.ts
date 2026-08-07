import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SupportTicketService } from './support-ticket.service';
import { SupportTicket } from '../../entities/SupportTickets/SupportTicket';
import { SupportTicketEvent } from '../../entities/SupportTickets/SupportTicketEvent';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../../common/errors';
import { PERMISSION } from '../../rbac/rbac.constants';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const ACTOR = { id: 'user-1', email: 'owner@clinic.test' };

/** A super_admin-shaped actor: holds every platform.support_tickets.* slug (the '*' wildcard). */
const SUPER_ADMIN_ACTOR = {
  ...ACTOR,
  role: 'super_admin',
  permissions: [
    PERMISSION.PLATFORM_SUPPORT_TICKETS_READ,
    PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE,
    PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY,
    PERMISSION.PLATFORM_SUPPORT_TICKETS_CLOSE,
  ],
};

/** A Platform Customer Service actor: read/triage/reply — NEVER close. */
const PLATFORM_SUPPORT_ACTOR = {
  ...ACTOR,
  role: 'platform_support',
  permissions: [
    PERMISSION.PLATFORM_SUPPORT_TICKETS_READ,
    PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE,
    PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY,
  ],
};

describe('SupportTicketService', () => {
  let service: SupportTicketService;
  let tickets: MockRepository;
  let events: MockRepository;
  let dataSource: { query: jest.Mock };
  let storage: {
    assertKeyBelongsToTenant: jest.Mock;
    objectExists: jest.Mock;
    getSignedDownloadUrl: jest.Mock;
  };

  beforeEach(async () => {
    tickets = createMockRepository();
    events = createMockRepository();
    dataSource = { query: jest.fn() };
    storage = {
      assertKeyBelongsToTenant: jest.fn(),
      objectExists: jest.fn(async () => true),
      getSignedDownloadUrl: jest.fn(async () => 'https://signed.example/attachment'),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportTicketService,
        { provide: getRepositoryToken(SupportTicket), useValue: tickets },
        { provide: getRepositoryToken(SupportTicketEvent), useValue: events },
        { provide: DataSource, useValue: dataSource },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = moduleRef.get(SupportTicketService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Creation ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a ticket under the caller tenant, starting at status "open"', async () => {
      dataSource.query.mockResolvedValueOnce([{ n: 1000 }]);
      tickets.save.mockImplementationOnce(async (t: any) => ({ id: 'ticket-1', ...t }));

      const dto = {
        subject: 'Cannot load calendar',
        category: 'technical',
        priority: 'medium',
        description: 'Calendar view is blank since this morning.',
      } as any;

      const result = await service.create(TENANT, ACTOR, dto);

      expect(tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: { id: TENANT },
          ticket_number: 'SUP-001000',
          status: 'open',
          created_by_email: ACTOR.email,
        }),
      );
      expect(result).toEqual(expect.objectContaining({ status: 'open' }));
    });

    it('stores an optional preferredContactTime as a Date', async () => {
      dataSource.query.mockResolvedValueOnce([{ n: 1004 }]);
      tickets.save.mockImplementationOnce(async (t: any) => t);

      const dto = {
        subject: 'Cannot load calendar',
        category: 'technical',
        priority: 'medium',
        description: 'Calendar view is blank since this morning.',
        preferredContactTime: '2026-08-10T09:30:00.000Z',
      } as any;

      await service.create(TENANT, ACTOR, dto);

      expect(tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({ preferred_contact_time: new Date('2026-08-10T09:30:00.000Z') }),
      );
    });

    it('leaves preferredContactTime unset when the clinic does not provide one', async () => {
      dataSource.query.mockResolvedValueOnce([{ n: 1005 }]);
      tickets.save.mockImplementationOnce(async (t: any) => t);

      const dto = {
        subject: 'Cannot load calendar',
        category: 'technical',
        priority: 'medium',
        description: 'Calendar view is blank since this morning.',
      } as any;

      await service.create(TENANT, ACTOR, dto);

      expect(tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({ preferred_contact_time: undefined }),
      );
    });

    it('ignores a spoofed tenantId on the dto — tenant always comes from the ctx.requireTenantId() argument', async () => {
      dataSource.query.mockResolvedValueOnce([{ n: 1001 }]);
      tickets.save.mockImplementationOnce(async (t: any) => t);

      const dto = {
        subject: 'Test',
        category: 'other',
        priority: 'low',
        description: 'Some description text here.',
        tenantId: OTHER_TENANT, // not a real DTO field, but simulate a smuggled value
      } as any;

      await service.create(TENANT, ACTOR, dto);

      expect(tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: { id: TENANT } }),
      );
    });

    it('validates an attachment belongs to the tenant and exists before attaching it', async () => {
      dataSource.query.mockResolvedValueOnce([{ n: 1002 }]);
      tickets.save.mockImplementationOnce(async (t: any) => t);
      storage.objectExists.mockResolvedValueOnce(true);

      const dto = {
        subject: 'With attachment',
        category: 'other',
        priority: 'low',
        description: 'Some description text here.',
        attachmentKey: `${TENANT}/support_ticket/file.pdf`,
      } as any;

      await service.create(TENANT, ACTOR, dto);

      expect(storage.assertKeyBelongsToTenant).toHaveBeenCalledWith(dto.attachmentKey, TENANT);
      expect(storage.objectExists).toHaveBeenCalledWith(dto.attachmentKey);
      expect(tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({ attachment_key: dto.attachmentKey }),
      );
    });

    it('rejects an attachment that does not exist in storage', async () => {
      dataSource.query.mockResolvedValueOnce([{ n: 1003 }]);
      storage.objectExists.mockResolvedValueOnce(false);

      const dto = {
        subject: 'With missing attachment',
        category: 'other',
        priority: 'low',
        description: 'Some description text here.',
        attachmentKey: `${TENANT}/support_ticket/missing.pdf`,
      } as any;

      await expect(service.create(TENANT, ACTOR, dto)).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
      expect(tickets.save).not.toHaveBeenCalled();
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('lists tickets scoped to the caller tenant', async () => {
      tickets.findAndCount.mockResolvedValueOnce([[], 0]);
      const query = { page: 1, limit: 20, sortBy: 'created_at', sortOrder: 'DESC' } as any;

      await service.listForTenant(TENANT, query);

      expect(tickets.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenant: { id: TENANT } }),
          skip: 0,
          take: 20,
        }),
      );
    });

    it('never returns another tenant\'s ticket (404, not a cross-tenant leak)', async () => {
      tickets.findOne.mockResolvedValueOnce(null); // filtered out by the tenant clause
      await expect(service.getForTenant(OTHER_TENANT, 'ticket-1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(tickets.findOne).toHaveBeenCalledWith({
        where: { id: 'ticket-1', tenant: { id: OTHER_TENANT } },
      });
    });

    it('tenant detail view excludes internal admin notes', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.getForTenant(TENANT, 'ticket-1');

      expect(events.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticket: { id: 'ticket-1' }, internal_only: false },
        }),
      );
    });

    it('super-admin read is not tenant-filtered', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.getForAdmin('ticket-1');

      expect(tickets.findOne).toHaveBeenCalledWith({
        where: { id: 'ticket-1' },
        relations: { tenant: true },
      });
    });

    it('super-admin list supports an explicit tenant filter without requiring one', async () => {
      tickets.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listForAdmin({ page: 1, limit: 20, sortBy: 'created_at', sortOrder: 'DESC', tenantId: TENANT } as any);

      expect(tickets.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenant: { id: TENANT } }) }),
      );
    });
  });

  // ── Status transitions ────────────────────────────────────────────────────

  describe('status transitions', () => {
    const baseTicket = () => ({
      id: 'ticket-1',
      status: 'open',
      resolved_at: null,
      closed_at: null,
      tenant: { id: TENANT },
    });

    it('rejects a no-op transition to the current status', async () => {
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'open' });
      await expect(
        service.updateStatus('ticket-1', SUPER_ADMIN_ACTOR, { status: 'open' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('resolving sets resolved_at and records a STATUS_CHANGED event', async () => {
      tickets.findOne.mockResolvedValueOnce(baseTicket());
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      // getForAdmin() re-fetch at the end
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'resolved' });
      events.find.mockResolvedValueOnce([]);

      await service.updateStatus('ticket-1', SUPER_ADMIN_ACTOR, { status: 'resolved', note: 'Fixed.' } as any);

      expect(tickets.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'resolved', resolved_at: expect.any(Date) }),
      );
      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'STATUS_CHANGED',
          from_value: 'open',
          to_value: 'resolved',
          note: 'Fixed.',
          internal_only: false,
        }),
      );
    });

    it('closing sets closed_at and backfills resolved_at if unset', async () => {
      tickets.findOne.mockResolvedValueOnce(baseTicket());
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'closed' });
      events.find.mockResolvedValueOnce([]);

      await service.updateStatus('ticket-1', SUPER_ADMIN_ACTOR, { status: 'closed' } as any);

      expect(tickets.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'closed',
          closed_at: expect.any(Date),
          resolved_at: expect.any(Date),
        }),
      );
    });

    it('reopening a resolved/closed ticket clears both timestamps', async () => {
      tickets.findOne.mockResolvedValueOnce({
        id: 'ticket-1',
        status: 'closed',
        resolved_at: new Date('2026-01-01'),
        closed_at: new Date('2026-01-02'),
      });
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'open', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.updateStatus('ticket-1', SUPER_ADMIN_ACTOR, { status: 'open' } as any);

      expect(tickets.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'open', resolved_at: null, closed_at: null }),
      );
    });

    it('repeated RESOLVED requests do not overwrite an already-set resolved_at', async () => {
      const existingResolvedAt = new Date('2026-01-01T00:00:00.000Z');
      // in_progress -> resolved a second time in a fresh cycle, but resolved_at
      // was somehow already populated (defensive: service must not clobber it).
      tickets.findOne.mockResolvedValueOnce({
        ...baseTicket(),
        status: 'in_progress',
        resolved_at: existingResolvedAt,
      });
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'resolved' });
      events.find.mockResolvedValueOnce([]);

      await service.updateStatus('ticket-1', SUPER_ADMIN_ACTOR, { status: 'resolved' } as any);

      expect(tickets.save).toHaveBeenCalledWith(
        expect.objectContaining({ resolved_at: existingResolvedAt }),
      );
    });

    it('records the actor role snapshot (super_admin) on the STATUS_CHANGED event', async () => {
      tickets.findOne.mockResolvedValueOnce(baseTicket());
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'resolved' });
      events.find.mockResolvedValueOnce([]);

      await service.updateStatus('ticket-1', SUPER_ADMIN_ACTOR, { status: 'resolved' } as any);

      expect(events.create).toHaveBeenCalledWith(expect.objectContaining({ actor_role: 'super_admin' }));
    });

    // ── Platform Customer Service — close boundary (dynamic permission check) ──

    it('Platform Support (no CLOSE) can triage to resolved', async () => {
      tickets.findOne.mockResolvedValueOnce(baseTicket());
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'resolved' });
      events.find.mockResolvedValueOnce([]);

      await expect(
        service.updateStatus('ticket-1', PLATFORM_SUPPORT_ACTOR, { status: 'resolved' } as any),
      ).resolves.toBeDefined();
      expect(events.create).toHaveBeenCalledWith(expect.objectContaining({ actor_role: 'platform_support' }));
    });

    it('Platform Support (no CLOSE) is FORBIDDEN from closing — the ticket and event log stay unchanged', async () => {
      await expect(
        service.updateStatus('ticket-1', PLATFORM_SUPPORT_ACTOR, { status: 'closed' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      // Rejected before the ticket is even loaded — no read, no write, no event.
      expect(tickets.findOne).not.toHaveBeenCalled();
      expect(tickets.save).not.toHaveBeenCalled();
      expect(events.create).not.toHaveBeenCalled();
    });

    it('an actor with no platform permissions at all (e.g. a clinic actor) is FORBIDDEN on any status change', async () => {
      await expect(
        service.updateStatus('ticket-1', ACTOR, { status: 'in_progress' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(tickets.findOne).not.toHaveBeenCalled();
    });
  });

  // ── Tenant self-service close ─────────────────────────────────────────────

  describe('closeOwnTicket (clinic self-service)', () => {
    it('closes a resolved ticket, sets closed_at, and records the actor role as "clinic"', async () => {
      tickets.findOne.mockResolvedValueOnce({
        id: 'ticket-1',
        status: 'resolved',
        closed_at: null,
        tenant: { id: TENANT },
      });
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      // getForTenant() re-fetch at the end
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'closed', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.closeOwnTicket(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1');

      expect(tickets.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'closed', closed_at: expect.any(Date) }),
      );
      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'STATUS_CHANGED',
          from_value: 'resolved',
          to_value: 'closed',
          actor_role: 'clinic',
          internal_only: false,
        }),
      );
    });

    it('rejects closing a ticket that is not yet resolved (e.g. still open/in_progress)', async () => {
      tickets.findOne.mockResolvedValueOnce({
        id: 'ticket-1',
        status: 'in_progress',
        tenant: { id: TENANT },
      });

      await expect(
        service.closeOwnTicket(TENANT, ACTOR, 'ticket-1'),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(tickets.save).not.toHaveBeenCalled();
    });

    it('repeated close requests do not overwrite closed_at (ticket is already closed, so the resolved-check now rejects it)', async () => {
      tickets.findOne.mockResolvedValueOnce({
        id: 'ticket-1',
        status: 'closed',
        closed_at: new Date('2026-01-01T00:00:00.000Z'),
        tenant: { id: TENANT },
      });

      await expect(
        service.closeOwnTicket(TENANT, ACTOR, 'ticket-1'),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(tickets.save).not.toHaveBeenCalled();
    });

    it('never returns/modifies another tenant\'s ticket (tenant-scoped lookup, 404 not found)', async () => {
      tickets.findOne.mockResolvedValueOnce(null); // filtered out by the tenant clause

      await expect(
        service.closeOwnTicket(OTHER_TENANT, ACTOR, 'ticket-1'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(tickets.findOne).toHaveBeenCalledWith({
        where: { id: 'ticket-1', tenant: { id: OTHER_TENANT } },
      });
      expect(tickets.save).not.toHaveBeenCalled();
    });
  });

  // ── Priority ───────────────────────────────────────────────────────────────

  describe('updatePriority', () => {
    it('rejects a no-op priority update', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', priority: 'high' });
      await expect(
        service.updatePriority('ticket-1', SUPER_ADMIN_ACTOR, { priority: 'high' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('records a PRIORITY_CHANGED event on change', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', priority: 'low' });
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', priority: 'urgent', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.updatePriority('ticket-1', SUPER_ADMIN_ACTOR, { priority: 'urgent' } as any);

      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIORITY_CHANGED', from_value: 'low', to_value: 'urgent' }),
      );
    });

    it('rejects an actor without the TRIAGE permission (backend-enforcement mirror of the controller guard)', async () => {
      await expect(
        service.updatePriority('ticket-1', ACTOR, { priority: 'urgent' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(tickets.findOne).not.toHaveBeenCalled();
    });
  });

  // ── Internal notes authorization ──────────────────────────────────────────

  describe('addNote', () => {
    it('records the note as internal_only — never visible to tenant reads', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1' });
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.addNote('ticket-1', ACTOR, { note: 'Escalated to engineering.' } as any);

      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'NOTE_ADDED', note: 'Escalated to engineering.', internal_only: true }),
      );
    });

    it('admin detail view separates history (tenant-visible) from notes (internal)', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([
        { id: 'e1', type: 'STATUS_CHANGED', internal_only: false, created_at: new Date() },
        { id: 'e2', type: 'NOTE_ADDED', internal_only: true, created_at: new Date() },
      ]);

      const result = await service.getForAdmin('ticket-1');

      expect(result.history).toHaveLength(1);
      expect(result.notes).toHaveLength(1);
    });
  });

  // ── KPIs ───────────────────────────────────────────────────────────────────

  describe('kpis', () => {
    it('maps the aggregate query result', async () => {
      dataSource.query.mockResolvedValueOnce([
        { open: 5, in_progress: 2, resolved: 10, urgent: 1 },
      ]);
      const result = await service.kpis();
      expect(result).toEqual({ open: 5, inProgress: 2, resolved: 10, urgent: 1 });
    });

    it('defaults to zeroes when the query returns no row', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      const result = await service.kpis();
      expect(result).toEqual({ open: 0, inProgress: 0, resolved: 0, urgent: 0 });
    });
  });

  // ── A1: bidirectional replies ───────────────────────────────────────────────

  describe('addTenantReply (clinic, own ticket)', () => {
    it('writes a REPLY event, internal_only=false, actor_role="clinic" — status untouched', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'resolved', tenant: { id: TENANT } });
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'resolved', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.addTenantReply(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1', { note: 'Still broken' } as any);

      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'REPLY', note: 'Still broken', internal_only: false, actor_role: 'clinic' }),
      );
      // A normal reply NEVER changes status — no ticket save at all.
      expect(tickets.save).not.toHaveBeenCalled();
    });

    it('another tenant\'s ticket id -> 404, no event written (IDOR-safe)', async () => {
      tickets.findOne.mockResolvedValueOnce(null); // filtered out by the tenant clause

      await expect(
        service.addTenantReply(OTHER_TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1', { note: 'x' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(events.create).not.toHaveBeenCalled();
    });

    it('rejects a reply on a closed ticket', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'closed', tenant: { id: TENANT } });

      await expect(
        service.addTenantReply(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1', { note: 'x' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(events.create).not.toHaveBeenCalled();
    });

    it('accepts a reply on a resolved ticket (that is precisely how a clinic says "not fixed" before using the explicit reopen action)', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'resolved', tenant: { id: TENANT } });
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'resolved', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await expect(
        service.addTenantReply(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1', { note: 'x' } as any),
      ).resolves.toBeDefined();
    });
  });

  describe('addPlatformReply (platform, any ticket)', () => {
    it('writes a REPLY event with actor_role="platform_support", visible cross-tenant', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'in_progress', tenant: { id: TENANT } });
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'in_progress', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.addPlatformReply('ticket-1', PLATFORM_SUPPORT_ACTOR, { note: 'Looking into it' } as any);

      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'REPLY', internal_only: false, actor_role: 'platform_support' }),
      );
    });
  });

  // ── A3: explicit "Issue not resolved" reopen ────────────────────────────────

  describe('reopenOwnTicket ("Issue not resolved")', () => {
    it('resolved -> in_progress, clears resolved_at, appends STATUS_CHANGED with the real clinic actor', async () => {
      tickets.findOne.mockResolvedValueOnce({
        id: 'ticket-1',
        status: 'resolved',
        resolved_at: new Date('2026-01-01'),
        closed_at: null,
        tenant: { id: TENANT },
      });
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'in_progress', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.reopenOwnTicket(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1', { note: 'Not fixed' } as any);

      expect(tickets.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'in_progress', resolved_at: null, closed_at: null }),
      );
      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'STATUS_CHANGED',
          from_value: 'resolved',
          to_value: 'in_progress',
          note: 'Not fixed',
          internal_only: false,
          actor: { id: ACTOR.id },
          actor_role: 'clinic',
        }),
      );
    });

    it('a normal reply on a resolved ticket does NOT reopen it — only this explicit action does', async () => {
      // Covered structurally: addTenantReply never touches status/resolved_at
      // (asserted above with `expect(tickets.save).not.toHaveBeenCalled()`),
      // and reopenOwnTicket is the only method that writes status='in_progress'
      // from 'resolved'. Re-asserted here for the specific pairing the plan calls out.
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'resolved', tenant: { id: TENANT } });
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'resolved', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([]);

      await service.addTenantReply(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1', { note: 'still broken' } as any);

      expect(tickets.save).not.toHaveBeenCalled();
    });

    it('rejects reopening a ticket that is not resolved', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'in_progress', tenant: { id: TENANT } });

      await expect(
        service.reopenOwnTicket(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1'),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(tickets.save).not.toHaveBeenCalled();
    });

    it('rejects reopening a CLOSED ticket', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'closed', tenant: { id: TENANT } });

      await expect(
        service.reopenOwnTicket(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1'),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(tickets.save).not.toHaveBeenCalled();
    });

    it('another tenant cannot reopen the ticket -> 404, target untouched', async () => {
      tickets.findOne.mockResolvedValueOnce(null); // filtered out by the tenant clause

      await expect(
        service.reopenOwnTicket(OTHER_TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(tickets.save).not.toHaveBeenCalled();
      expect(events.create).not.toHaveBeenCalled();
    });

    it('preserves prior history — recordEvent only ever appends', async () => {
      tickets.findOne.mockResolvedValueOnce({
        id: 'ticket-1',
        status: 'resolved',
        resolved_at: new Date(),
        closed_at: null,
        tenant: { id: TENANT },
      });
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'in_progress', tenant: { id: TENANT } });
      events.find.mockResolvedValueOnce([
        { id: 'e0', type: 'STATUS_CHANGED', internal_only: false, created_at: new Date() }, // the platform's earlier "resolved" transition
      ]);

      const result = await service.reopenOwnTicket(TENANT, { ...ACTOR, role: 'clinic' }, 'ticket-1');

      expect(events.save).toHaveBeenCalledTimes(1); // the append; nothing deleted
      expect(result.history).toHaveLength(1); // the pre-existing event is still there
    });
  });

  // ── D4: clinic filter ───────────────────────────────────────────────────────

  describe('listSupportClinics', () => {
    it('returns only clinics with at least one ticket — not the full tenant directory', async () => {
      dataSource.query.mockResolvedValueOnce([{ id: 't1', name: 'Al Noor Clinic' }]);
      const result = await service.listSupportClinics();
      expect(result).toEqual([{ id: 't1', name: 'Al Noor Clinic' }]);
      expect(dataSource.query.mock.calls[0][0]).toContain('INNER JOIN support_tickets');
    });
  });

  // ── Detail-only clinic contact fields (§3.2 / §4.3) ─────────────────────────

  describe('getForAdmin tenant projection', () => {
    it('includes contact fields on the detail view only', async () => {
      tickets.findOne.mockResolvedValueOnce({
        id: 'ticket-1',
        tenant: {
          id: TENANT,
          name: 'Al Noor',
          slug: 'al-noor',
          contact_email: 'clinic@example.com',
          contact_phone: '+966500000000',
          approval_status: 'APPROVED',
          is_active: true,
        },
      });
      events.find.mockResolvedValueOnce([]);

      const result = await service.getForAdmin('ticket-1');

      expect(result.tenant).toEqual({
        id: TENANT,
        name: 'Al Noor',
        slug: 'al-noor',
        contactEmail: 'clinic@example.com',
        contactPhone: '+966500000000',
        approvalStatus: 'APPROVED',
        isActive: true,
      });
    });

    it('the list view keeps the narrower {id, name} shape — no contact fields leaked in bulk', async () => {
      tickets.findAndCount.mockResolvedValueOnce([
        [{ id: 'ticket-1', tenant: { id: TENANT, name: 'Al Noor', contact_email: 'clinic@example.com' } }],
        1,
      ]);

      const result = await service.listForAdmin({ page: 1, limit: 20, sortBy: 'created_at', sortOrder: 'DESC' } as any);

      expect(result.data[0].tenant).toEqual({ id: TENANT, name: 'Al Noor' });
    });
  });

  // ── Pagination / sorting ───────────────────────────────────────────────────

  describe('pagination', () => {
    it('computes skip/take from page and limit for the tenant list', async () => {
      tickets.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listForTenant(TENANT, {
        page: 3,
        limit: 10,
        sortBy: 'priority',
        sortOrder: 'ASC',
      } as any);

      expect(tickets.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10, order: { priority: 'ASC' } }),
      );
    });
  });
});
