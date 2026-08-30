import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { InAppNotification } from '../../../entities/Notifications/InAppNotification';
import { NotificationPreference } from '../../../entities/Notifications/NotificationPreference';
import {
  createMockQueryBuilder,
  createMockRepository,
  type MockQueryBuilder,
  type MockRepository,
} from '../../../../test/utils/mock-factories';

import { InternalNotificationService } from './internal-notification.service';
import { NotificationRecipientResolver } from './notification-recipient.resolver';
import { NOTIFICATION_CATALOG } from './notification-catalog';

const TENANT = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TICKET = 'cccccccc-0000-4000-8000-00000000000c';
const EVENT = 'dddddddd-0000-4000-8000-00000000000d';

/** A mandatory SUPPORT key, and a mutable one — both real catalog entries. */
const MANDATORY_KEY = 'SUPPORT_TICKET_REPLIED';
const MUTABLE_KEY = 'SUPPORT_TICKET_STATUS_CHANGED';

describe('InternalNotificationService', () => {
  let service: InternalNotificationService;
  let notifications: MockRepository;
  let preferences: MockRepository;
  let resolver: { resolve: jest.Mock };
  let insertQb: MockQueryBuilder;

  const ctx = {
    tenantId: TENANT,
    actorUserId: 'actor-1',
    variables: { ticketNumber: 'SUP-000123', subject: 'Calendar blank' },
    refs: { ticketId: TICKET, eventId: EVENT },
  };

  /** Whatever `.values()` was handed on the insert builder. */
  const insertedRows = (): any[] => insertQb.values.mock.calls[0]?.[0] ?? [];

  beforeEach(async () => {
    notifications = createMockRepository();
    preferences = createMockRepository();
    insertQb = createMockQueryBuilder();
    notifications.createQueryBuilder.mockReturnValue(insertQb);
    insertQb.execute.mockResolvedValue({ identifiers: [{ id: 'n-1' }] });
    preferences.find.mockResolvedValue([]);
    resolver = { resolve: jest.fn().mockResolvedValue([]) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        InternalNotificationService,
        { provide: getRepositoryToken(InAppNotification), useValue: notifications },
        { provide: getRepositoryToken(NotificationPreference), useValue: preferences },
        { provide: NotificationRecipientResolver, useValue: resolver },
      ],
    }).compile();

    service = moduleRef.get(InternalNotificationService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('failure isolation', () => {
    /**
     * The single most important property here. Every caller is an `@OnEvent`
     * handler running after a domain transaction already committed — a ticket
     * reply is durable before this runs. A throw could not undo it; it could
     * only turn a cosmetic problem into a 500 on an operation that succeeded.
     */
    it('returns an error instead of throwing when the insert fails', async () => {
      resolver.resolve.mockResolvedValue([{ id: 'u-1', preferredLocale: null }]);
      insertQb.execute.mockRejectedValue(new Error('deadlock detected'));

      const result = await service.emit(MANDATORY_KEY, ctx);

      expect(result.error).toBe('deadlock detected');
      expect(result.created).toBe(0);
    });

    it('returns an error instead of throwing when recipient resolution fails', async () => {
      resolver.resolve.mockRejectedValue(new Error('connection terminated'));

      const result = await service.emit(MANDATORY_KEY, ctx);

      expect(result.error).toBe('connection terminated');
    });

    it('drops an unknown key rather than throwing', async () => {
      const result = await service.emit('NOT_A_REAL_KEY' as never, ctx);

      expect(result.error).toBe('unknown-key');
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(notifications.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('recipient handling', () => {
    it('writes nothing at all when nobody is eligible', async () => {
      resolver.resolve.mockResolvedValue([]);

      const result = await service.emit(MANDATORY_KEY, ctx);

      expect(result.created).toBe(0);
      // No empty INSERT — TypeORM would reject an empty values array anyway,
      // but the point is that the whole path short-circuits.
      expect(notifications.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('writes one row per recipient', async () => {
      resolver.resolve.mockResolvedValue([
        { id: 'u-1', preferredLocale: 'en' },
        { id: 'u-2', preferredLocale: 'ar' },
      ]);
      insertQb.execute.mockResolvedValue({
        identifiers: [{ id: 'n-1' }, { id: 'n-2' }],
      });

      const result = await service.emit(MANDATORY_KEY, ctx);

      expect(result.created).toBe(2);
      expect(insertedRows()).toHaveLength(2);
      expect(insertedRows().map((r) => r.recipient.id)).toEqual(['u-1', 'u-2']);
    });

    it('passes the actor to the resolver so it can be excluded', async () => {
      resolver.resolve.mockResolvedValue([]);

      await service.emit(MANDATORY_KEY, ctx);

      expect(resolver.resolve).toHaveBeenCalledWith(
        NOTIFICATION_CATALOG[MANDATORY_KEY].scope,
        TENANT,
        NOTIFICATION_CATALOG[MANDATORY_KEY].recipients,
        expect.objectContaining({ actorUserId: 'actor-1' }),
      );
    });

    it('resolves a PLATFORM notification with a null tenant even when the event names one', async () => {
      // SUPPORT_TICKET_OPENED concerns a clinic but is addressed to platform
      // staff. The tenant must not be used as a recipient filter, or it would
      // resolve nobody (no platform user belongs to a clinic).
      resolver.resolve.mockResolvedValue([]);

      await service.emit('SUPPORT_TICKET_OPENED', ctx);

      expect(resolver.resolve).toHaveBeenCalledWith(
        'PLATFORM',
        null,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('preferences', () => {
    it('never consults preferences for a mandatory notification', async () => {
      resolver.resolve.mockResolvedValue([{ id: 'u-1', preferredLocale: null }]);

      await service.emit(MANDATORY_KEY, ctx);

      // The second of two independent enforcement points: even a `muted` row
      // written straight into the database cannot suppress a mandatory
      // notification, because this path never looks.
      expect(preferences.find).not.toHaveBeenCalled();
    });

    it('suppresses a muted category for a non-mandatory notification', async () => {
      resolver.resolve.mockResolvedValue([
        { id: 'u-muted', preferredLocale: null },
        { id: 'u-open', preferredLocale: null },
      ]);
      preferences.find.mockResolvedValue([{ id: 'p-1', user: { id: 'u-muted' } }]);
      insertQb.execute.mockResolvedValue({ identifiers: [{ id: 'n-1' }] });

      const result = await service.emit(MUTABLE_KEY, ctx);

      expect(result.suppressed).toBe(1);
      expect(insertedRows().map((r) => r.recipient.id)).toEqual(['u-open']);
    });

    it('delivers to a user who has never set any preference', async () => {
      // Absence of a row means "not muted" — no seeding or backfill required.
      resolver.resolve.mockResolvedValue([{ id: 'u-1', preferredLocale: null }]);
      preferences.find.mockResolvedValue([]);

      const result = await service.emit(MUTABLE_KEY, ctx);

      expect(result.suppressed).toBe(0);
      expect(result.created).toBe(1);
    });

    it('writes nothing when every recipient muted the category', async () => {
      resolver.resolve.mockResolvedValue([{ id: 'u-1', preferredLocale: null }]);
      preferences.find.mockResolvedValue([{ id: 'p-1', user: { id: 'u-1' } }]);

      const result = await service.emit(MUTABLE_KEY, ctx);

      expect(result.suppressed).toBe(1);
      expect(result.created).toBe(0);
      expect(notifications.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('row contents', () => {
    beforeEach(() => {
      resolver.resolve.mockResolvedValue([{ id: 'u-1', preferredLocale: null }]);
    });

    it('stores the catalog key and variables, not rendered text', async () => {
      await service.emit(MANDATORY_KEY, ctx);

      const [row] = insertedRows();
      expect(row.key).toBe(MANDATORY_KEY);
      expect(row.variables).toEqual(ctx.variables);
      // Rendering happens at READ time, in the reader's own language — a stored
      // title would freeze one language into the row.
      expect(row).not.toHaveProperty('title');
      expect(row).not.toHaveProperty('body');
    });

    it('denormalizes category and priority from the catalog', async () => {
      await service.emit(MANDATORY_KEY, ctx);

      const [row] = insertedRows();
      expect(row.category).toBe(NOTIFICATION_CATALOG[MANDATORY_KEY].category);
      expect(row.priority).toBe(NOTIFICATION_CATALOG[MANDATORY_KEY].priority);
    });

    it('computes the dedupe key, deep link and entity from the context', async () => {
      await service.emit(MANDATORY_KEY, ctx);

      const [row] = insertedRows();
      expect(row.dedupe_key).toBe(`ticket:reply:${EVENT}`);
      expect(row.link_url).toBe(`/app/support?ticket=${TICKET}`);
      expect(row.entity_type).toBe('SupportTicket');
      expect(row.entity_id).toBe(TICKET);
    });

    it('records the originating tenant on a TENANT notification', async () => {
      await service.emit(MANDATORY_KEY, ctx);

      expect(insertedRows()[0].tenant).toEqual({ id: TENANT });
    });

    it('leaves the tenant null on a PLATFORM notification', async () => {
      await service.emit('SUPPORT_TICKET_OPENED', ctx);

      expect(insertedRows()[0].tenant).toBeNull();
    });

    it('inserts with ON CONFLICT DO NOTHING so a replay is a no-op', async () => {
      await service.emit(MANDATORY_KEY, ctx);

      expect(insertQb.orIgnore).toHaveBeenCalled();
    });

    it('reports zero created when the database ignored every row', async () => {
      // What a genuine duplicate event looks like: the insert succeeds and
      // returns no identifiers, because the unique index rejected each row.
      insertQb.execute.mockResolvedValue({ identifiers: [{}] });

      const result = await service.emit(MANDATORY_KEY, ctx);

      expect(result.created).toBe(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe('fan-out cap', () => {
    it('truncates an oversized fan-out rather than writing unbounded rows', async () => {
      const many = Array.from({ length: 250 }, (_, i) => ({
        id: `u-${i}`,
        preferredLocale: null,
      }));
      resolver.resolve.mockResolvedValue(many);

      await service.emit(MANDATORY_KEY, ctx);

      // Default INTERNAL_NOTIFICATION_MAX_FANOUT is 200.
      expect(insertedRows()).toHaveLength(200);
    });
  });
});
