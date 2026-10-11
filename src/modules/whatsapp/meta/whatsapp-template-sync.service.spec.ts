import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappTemplateSyncService } from './whatsapp-template-sync.service';
import { MetaGraphClient } from './meta-graph.client';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';
import { WhatsappTemplate } from '../../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { ErrorCode } from '../../../common/errors';
import { WHATSAPP_TEMPLATE_STATUS } from '../whatsapp.constants';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockQueryBuilder,
  MockRepository,
} from '../../../../test/utils/mock-factories';

const TENANT = 't1';

const RESOLVED = {
  id: 'acc-1',
  wabaId: 'waba-1',
  accessToken: 'token-1',
  source: 'CUSTOM' as const,
  mode: 'CUSTOM' as const,
};

describe('WhatsappTemplateSyncService', () => {
  let service: WhatsappTemplateSyncService;
  let templates: MockRepository;
  let accounts: MockRepository;
  let qb: MockQueryBuilder;
  let graph: { listTemplates: jest.Mock };
  let resolver: { byId: jest.Mock; forTenant: jest.Mock };

  beforeEach(async () => {
    templates = createMockRepository();
    accounts = createMockRepository();
    templates.create.mockImplementation((v: object) => ({ ...v }));
    templates.save.mockImplementation(async (v: object) => v);
    qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: 1 });
    templates.createQueryBuilder.mockReturnValue(qb);
    graph = { listTemplates: jest.fn().mockResolvedValue([]) };
    resolver = {
      byId: jest.fn().mockResolvedValue(RESOLVED),
      forTenant: jest.fn().mockResolvedValue(RESOLVED),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappTemplateSyncService,
        { provide: getRepositoryToken(WhatsappTemplate), useValue: templates },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: MetaGraphClient, useValue: graph },
        { provide: WhatsappAccountResolver, useValue: resolver },
      ],
    }).compile();
    service = moduleRef.get(WhatsappTemplateSyncService);
  });

  afterEach(() => jest.clearAllMocks());

  const remote = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'meta-tpl-1',
    name: 'appointment_reminder',
    language: 'ar',
    status: 'APPROVED',
    category: 'UTILITY',
    ...over,
  });

  describe('account selection', () => {
    it('uses the tenant default when no account is named', async () => {
      await service.syncAccount(TENANT);
      expect(resolver.forTenant).toHaveBeenCalledWith(TENANT);
    });

    it('uses the named account when given (tenant-scoped by the resolver)', async () => {
      await service.syncAccount(TENANT, 'acc-9');
      expect(resolver.byId).toHaveBeenCalledWith(TENANT, 'acc-9');
    });

    it('fails when the account has no connected WABA', async () => {
      resolver.forTenant.mockResolvedValueOnce({ ...RESOLVED, wabaId: undefined });

      await expect(service.syncAccount(TENANT)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('upsert', () => {
    it('creates a new template and stamps the WABA it came from', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote()]);
      templates.findOne.mockResolvedValue(null);

      const result = await service.syncAccount(TENANT);

      expect(result).toMatchObject({ fetched: 1, created: 1, updated: 0 });
      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider_template_id: 'meta-tpl-1',
          // Campaigns match template↔account on this; it must be stored.
          waba_id: 'waba-1',
          status: WHATSAPP_TEMPLATE_STATUS.APPROVED,
        }),
      );
    });

    it('matches on Meta\'s id first, so a RENAME updates instead of duplicating', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote({ name: 'renamed_in_meta' })]);
      templates.findOne.mockResolvedValueOnce({ id: 'local-1', name: 'old_name' });

      const result = await service.syncAccount(TENANT);

      expect(result).toMatchObject({ created: 0, updated: 1 });
      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'local-1', name: 'renamed_in_meta' }),
      );
    });

    it('adopts a pre-sync local row by (name, language) instead of colliding', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote()]);
      templates.findOne
        .mockResolvedValueOnce(null) // no provider-id match
        .mockResolvedValueOnce({ id: 'local-legacy' }); // name+language match

      await service.syncAccount(TENANT);

      // UNIQUE(tenant, name, language) would reject an insert here.
      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'local-legacy', provider_template_id: 'meta-tpl-1' }),
      );
    });

    it('stamps last_synced_at on the account', async () => {
      await service.syncAccount(TENANT);
      expect(accounts.update).toHaveBeenCalledWith(
        { id: 'acc-1' },
        expect.objectContaining({ last_synced_at: expect.any(Date) }),
      );
    });
  });

  describe('status mapping (Meta always wins)', () => {
    it.each([
      ['APPROVED', WHATSAPP_TEMPLATE_STATUS.APPROVED],
      ['REJECTED', WHATSAPP_TEMPLATE_STATUS.REJECTED],
      ['PAUSED', WHATSAPP_TEMPLATE_STATUS.PAUSED],
      ['LIMIT_EXCEEDED', WHATSAPP_TEMPLATE_STATUS.PAUSED],
      ['DISABLED', WHATSAPP_TEMPLATE_STATUS.DISABLED],
      ['PENDING', WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW],
      ['IN_APPEAL', WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW],
    ])('maps Meta "%s" to %s', async (metaStatus, expected) => {
      graph.listTemplates.mockResolvedValueOnce([remote({ status: metaStatus })]);
      templates.findOne.mockResolvedValue(null);

      await service.syncAccount(TENANT);

      expect(templates.save).toHaveBeenCalledWith(expect.objectContaining({ status: expected }));
    });

    it('treats an UNKNOWN Meta status as pending — never as sendable', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote({ status: 'SOME_NEW_META_STATUS' })]);
      templates.findOne.mockResolvedValue(null);

      await service.syncAccount(TENANT);

      // Defaulting an unknown status to APPROVED would push messages Meta rejects.
      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW }),
      );
    });

    it('overwrites a locally-approved template that Meta has since rejected', async () => {
      graph.listTemplates.mockResolvedValueOnce([
        remote({ status: 'REJECTED', rejected_reason: undefined, rejectedReason: 'SCAM' }),
      ]);
      templates.findOne.mockResolvedValueOnce({
        id: 'local-1',
        status: WHATSAPP_TEMPLATE_STATUS.APPROVED,
      });

      await service.syncAccount(TENANT);

      // This is exactly the state that causes silent campaign failure.
      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: WHATSAPP_TEMPLATE_STATUS.REJECTED,
          rejected_reason: 'SCAM',
        }),
      );
    });
  });

  describe('components normalization', () => {
    it('wraps Meta\'s array into the jsonb object column', async () => {
      graph.listTemplates.mockResolvedValueOnce([
        remote({ components: [{ type: 'BODY', text: 'Hi {{1}}' }] }),
      ]);
      templates.findOne.mockResolvedValue(null);

      await service.syncAccount(TENANT);

      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({
          components: { components: [{ type: 'BODY', text: 'Hi {{1}}' }] },
        }),
      );
    });
  });

  describe('syncAfterOnboarding', () => {
    it('never lets a sync failure undo a valid connection', async () => {
      graph.listTemplates.mockRejectedValueOnce(new Error('Meta is down'));

      // The clinic IS connected; templates can be re-synced from the UI.
      await expect(service.syncAfterOnboarding(TENANT, 'acc-1')).resolves.toBeUndefined();
    });
  });

  // ─────────────────────── reconciliation hardening ───────────────────────

  describe('reconciliation hardening', () => {
    it('clears a stale rejection reason when Meta approves ("NONE" is not a reason)', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote({ status: 'APPROVED', rejectedReason: 'NONE' })]);
      templates.findOne.mockResolvedValueOnce({ id: 'local-1', rejected_reason: 'OLD' });

      await service.syncAccount(TENANT);

      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved', rejected_reason: null }),
      );
    });

    it('keeps the parameter format so the send path can fill NAMED templates by name', async () => {
      graph.listTemplates.mockResolvedValueOnce([
        remote({ components: [{ type: 'BODY', text: 'Hi {{name}}' }], parameterFormat: 'named' }),
      ]);
      templates.findOne.mockResolvedValue(null);

      await service.syncAccount(TENANT);

      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({
          components: { components: [{ type: 'BODY', text: 'Hi {{name}}' }], parameter_format: 'NAMED' },
        }),
      );
    });

    it('revives a soft-deleted row (looked up withDeleted) instead of hitting the unique key', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote()]);
      templates.findOne.mockResolvedValueOnce({ id: 'tomb', deleted_at: new Date() });

      await service.syncAccount(TENANT);

      expect(templates.findOne.mock.calls[0][0]).toMatchObject({ withDeleted: true });
      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tomb', deleted_at: null }),
      );
    });

    it('does not let one bad template abort the rest, and never prunes after a partial write', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote({ id: 'a' }), remote({ id: 'b', name: 'other' })]);
      templates.findOne.mockResolvedValue(null);
      templates.save.mockRejectedValueOnce(new Error('bad row')).mockImplementation(async (v: object) => v);

      const result = await service.syncAccount(TENANT);

      expect(result).toMatchObject({ fetched: 2, created: 1, failed: 1, removed: 0 });
      expect(templates.find).not.toHaveBeenCalled(); // no prune query at all
    });

    it('removes mirror rows Meta no longer lists (scoped to this tenant + WABA)', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote({ id: 'kept' })]);
      templates.findOne.mockResolvedValue(null);
      const old = new Date(Date.now() - 3_600_000);
      templates.find.mockResolvedValueOnce([
        { id: 'gone-1', provider_template_id: 'deleted-on-meta', last_synced_at: old },
      ]);

      const result = await service.syncAccount(TENANT);

      expect(result.removed).toBe(1);
      expect(templates.softRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'gone-1' }));
      const where = templates.find.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenant: { id: TENANT }, waba_id: 'waba-1' });
    });

    it('does not overwrite a row a webhook updated AFTER the pull began', async () => {
      graph.listTemplates.mockResolvedValueOnce([remote({ status: 'PENDING' })]);
      templates.findOne.mockResolvedValueOnce({
        id: 'local-1',
        status: 'approved',
        last_synced_at: new Date(Date.now() + 60_000),
      });

      const result = await service.syncAccount(TENANT);

      expect(templates.save).not.toHaveBeenCalled();
      expect(result).toMatchObject({ created: 0, updated: 0 });
    });
  });

  // ─────────────────────────── webhook application ───────────────────────────

  describe('applyWebhookEvent', () => {
    const T = 1_760_000_000; // seconds
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'local-1',
      waba_id: 'waba-1',
      provider_template_id: 'meta-tpl-1',
      status: 'pending_review',
      last_synced_at: new Date((T - 600) * 1000),
      ...over,
    });
    const ev = (over: Record<string, unknown> = {}) => ({
      field: 'message_template_status_update' as const,
      wabaId: 'waba-1',
      templateId: 'meta-tpl-1',
      eventTime: T,
      event: 'APPROVED',
      ...over,
    });

    it('Pending to Approved: writes the verdict and moves last_synced_at to the event time', async () => {
      templates.find.mockResolvedValueOnce([row()]);

      const out = await service.applyWebhookEvent(ev());

      expect(out).toEqual({ applied: true, rows: 1 });
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'approved',
          rejected_reason: null,
          last_synced_at: new Date(T * 1000),
        }),
      );
    });

    it('Rejected: stores the reason, with Meta recommendation for INVALID_FORMAT', async () => {
      templates.find.mockResolvedValueOnce([row()]);

      await service.applyWebhookEvent(
        ev({ event: 'REJECTED', reason: 'INVALID_FORMAT', rejectionRecommendation: 'Remove the trailing variable' }),
      );

      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'rejected',
          rejected_reason: 'INVALID_FORMAT: Remove the trailing variable',
        }),
      );
    });

    it.each([
      ['PAUSED', 'paused'],
      ['DISABLED', 'disabled'],
    ])('%s becomes %s (not sendable)', async (event, status) => {
      templates.find.mockResolvedValueOnce([row({ status: 'approved' })]);
      await service.applyWebhookEvent(ev({ event, reason: 'NONE' }));
      expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ status, rejected_reason: null }));
    });

    it('ignores an event for a template this platform does not mirror', async () => {
      templates.find.mockResolvedValueOnce([]);
      await expect(service.applyWebhookEvent(ev())).resolves.toEqual({
        applied: false,
        reason: 'unknown-template',
      });
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('looks the row up by BOTH waba and template id (an event cannot reach another WABA)', async () => {
      templates.find.mockResolvedValueOnce([]);
      await service.applyWebhookEvent(ev({ wabaId: 'waba-OTHER' }));
      expect(templates.find.mock.calls[0][0].where).toMatchObject({
        waba_id: 'waba-OTHER',
        provider_template_id: 'meta-tpl-1',
      });
    });

    it('out-of-order: an OLDER event is rejected by the guarded UPDATE (nothing changes)', async () => {
      templates.find.mockResolvedValueOnce([row({ status: 'approved', last_synced_at: new Date(T * 1000) })]);
      qb.execute.mockResolvedValueOnce({ affected: 0 });

      const out = await service.applyWebhookEvent(ev({ event: 'PENDING', eventTime: T - 300 }));

      expect(out).toEqual({ applied: false, reason: 'stale' });
      // The ordering guard is in the statement itself, not a read-then-write.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('last_synced_at'),
        expect.objectContaining({ bound: new Date((T - 300 + 1) * 1000) }),
      );
    });

    it('duplicate delivery is idempotent: the same verdict is simply written again', async () => {
      templates.find.mockResolvedValue([row()]);
      await service.applyWebhookEvent(ev());
      await service.applyWebhookEvent(ev());
      const patches = qb.set.mock.calls.map((c: any[]) => c[0]);
      expect(patches[0]).toEqual(patches[1]);
    });

    it('FLAGGED is a quality warning on a still-approved template: status untouched', async () => {
      templates.find.mockResolvedValueOnce([row({ status: 'approved' })]);
      await expect(service.applyWebhookEvent(ev({ event: 'FLAGGED' }))).resolves.toEqual({
        applied: false,
        reason: 'no-status-change',
      });
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('an unknown event name is treated as pending, never as approved', async () => {
      templates.find.mockResolvedValueOnce([row()]);
      await service.applyWebhookEvent(ev({ event: 'SOMETHING_NEW' }));
      expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
    });

    it('DELETED removes the mirror row', async () => {
      templates.find.mockResolvedValueOnce([row()]);
      const out = await service.applyWebhookEvent(ev({ event: 'DELETED', reason: null }));
      expect(out).toEqual({ applied: true, rows: 1 });
      expect(templates.softRemove).toHaveBeenCalled();
    });

    it('a COMPLETED category change updates the category (marketing consent depends on it)', async () => {
      templates.find.mockResolvedValueOnce([row({ status: 'approved' })]);
      await service.applyWebhookEvent({
        field: 'template_category_update',
        wabaId: 'waba-1',
        templateId: 'meta-tpl-1',
        eventTime: T,
        category: 'MARKETING',
      });
      expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ category: 'MARKETING' }));
    });

    it('an IMPENDING category change is informational only', async () => {
      templates.find.mockResolvedValueOnce([row()]);
      await expect(
        service.applyWebhookEvent({
          field: 'template_category_update',
          wabaId: 'waba-1',
          templateId: 'meta-tpl-1',
          eventTime: T,
          category: 'UTILITY',
          impendingCategoryChange: true,
        }),
      ).resolves.toEqual({ applied: false, reason: 'ignored' });
      expect(qb.execute).not.toHaveBeenCalled();
    });
  });

  describe('tenantsForTemplate', () => {
    it('attributes an event only to tenants that own that exact (waba, template) row', async () => {
      templates.find.mockResolvedValueOnce([{ tenant: { id: 't1' } }, { tenant: { id: 't1' } }]);
      await expect(service.tenantsForTemplate('waba-1', 'meta-tpl-1')).resolves.toEqual(['t1']);
      expect(templates.find.mock.calls[0][0].where).toMatchObject({
        waba_id: 'waba-1',
        provider_template_id: 'meta-tpl-1',
      });
    });
  });
});
