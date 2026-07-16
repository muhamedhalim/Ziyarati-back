import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SupportTicketService } from './support-ticket.service';
import { SupportTicket } from '../../entities/SupportTickets/SupportTicket';
import { SupportTicketEvent } from '../../entities/SupportTickets/SupportTicketEvent';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const ACTOR = { id: 'user-1', email: 'owner@clinic.test' };

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
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1' });
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
    });

    it('rejects a no-op transition to the current status', async () => {
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'open' });
      await expect(
        service.updateStatus('ticket-1', ACTOR, { status: 'open' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('resolving sets resolved_at and records a STATUS_CHANGED event', async () => {
      tickets.findOne.mockResolvedValueOnce(baseTicket());
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      // getForAdmin() re-fetch at the end
      tickets.findOne.mockResolvedValueOnce({ ...baseTicket(), status: 'resolved' });
      events.find.mockResolvedValueOnce([]);

      await service.updateStatus('ticket-1', ACTOR, { status: 'resolved', note: 'Fixed.' } as any);

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

      await service.updateStatus('ticket-1', ACTOR, { status: 'closed' } as any);

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
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', status: 'open' });
      events.find.mockResolvedValueOnce([]);

      await service.updateStatus('ticket-1', ACTOR, { status: 'open' } as any);

      expect(tickets.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'open', resolved_at: null, closed_at: null }),
      );
    });
  });

  // ── Priority ───────────────────────────────────────────────────────────────

  describe('updatePriority', () => {
    it('rejects a no-op priority update', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', priority: 'high' });
      await expect(
        service.updatePriority('ticket-1', ACTOR, { priority: 'high' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('records a PRIORITY_CHANGED event on change', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', priority: 'low' });
      tickets.save.mockImplementationOnce(async (t: any) => t);
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1', priority: 'urgent' });
      events.find.mockResolvedValueOnce([]);

      await service.updatePriority('ticket-1', ACTOR, { priority: 'urgent' } as any);

      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIORITY_CHANGED', from_value: 'low', to_value: 'urgent' }),
      );
    });
  });

  // ── Internal notes authorization ──────────────────────────────────────────

  describe('addNote', () => {
    it('records the note as internal_only — never visible to tenant reads', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1' });
      events.save.mockImplementationOnce(async (e: any) => e);
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1' });
      events.find.mockResolvedValueOnce([]);

      await service.addNote('ticket-1', ACTOR, { note: 'Escalated to engineering.' } as any);

      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'NOTE_ADDED', note: 'Escalated to engineering.', internal_only: true }),
      );
    });

    it('admin detail view separates history (tenant-visible) from notes (internal)', async () => {
      tickets.findOne.mockResolvedValueOnce({ id: 'ticket-1' });
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
