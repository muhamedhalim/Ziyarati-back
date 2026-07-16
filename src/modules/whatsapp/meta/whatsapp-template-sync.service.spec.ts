import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappTemplateSyncService } from './whatsapp-template-sync.service';
import { MetaGraphClient } from './meta-graph.client';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';
import { WhatsappTemplate } from '../../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { ErrorCode } from '../../../common/errors';
import { WHATSAPP_TEMPLATE_STATUS } from '../whatsapp.constants';
import { createMockRepository, MockRepository } from '../../../../test/utils/mock-factories';

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
  let graph: { listTemplates: jest.Mock };
  let resolver: { byId: jest.Mock; forTenant: jest.Mock };

  beforeEach(async () => {
    templates = createMockRepository();
    accounts = createMockRepository();
    templates.create.mockImplementation((v: object) => ({ ...v }));
    templates.save.mockImplementation(async (v: object) => v);
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
      ['PAUSED', WHATSAPP_TEMPLATE_STATUS.DISABLED],
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
});
