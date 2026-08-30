import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CampaignExecutionService } from './campaign-execution.service';
import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignLifecycle, CampaignExecution } from '../../entities/enums';
import { CampaignRunService } from './campaign-run.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { CustomerSegmentService } from '../crm/customer-segment.service';
import {
  CampaignAuditService,
  CAMPAIGN_AUDIT_ACTION,
} from './campaign-audit.service';
import { AppError } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CAMPAIGN_ID = 'camp-1';

describe('CampaignExecutionService — Phase 11 (US7) additions', () => {
  let service: CampaignExecutionService;
  let campaigns: MockRepository;
  let recipients: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let runs: { currentEditable: jest.Mock };
  let whatsappRouter: { resolveForSend: jest.Mock };
  let templates: { getSendableTemplate: jest.Mock };
  let segments: { preview: jest.Mock };
  let audit: { record: jest.Mock };

  const baseCampaign = {
    id: CAMPAIGN_ID,
    lifecycle: CampaignLifecycle.DRAFT,
    channel: 'EMAIL',
    email_subject: 'Big sale',
    email_body: 'Come visit us',
    daily_cap: null,
    monthly_cap: null,
    template: null,
    audience_segment: null,
    scheduled_at: null,
  };

  beforeEach(async () => {
    campaigns = createMockRepository();
    recipients = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    runs = { currentEditable: jest.fn() };
    whatsappRouter = { resolveForSend: jest.fn() };
    templates = { getSendableTemplate: jest.fn() };
    segments = { preview: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    // `loadOwned` (used by assertSendable AND the post-transaction return read).
    campaigns.findOne.mockResolvedValue(baseCampaign);
    manager.findOne.mockResolvedValue({ ...baseCampaign });
    manager.count = jest.fn().mockResolvedValue(3);
    manager.save = jest.fn().mockImplementation((_, v) => v ?? {});
    manager.create = jest.fn((_, v) => v);
    runs.currentEditable.mockResolvedValue({
      id: 'run-1',
      idempotency_key: 'idem-1',
      execution: CampaignExecution.IDLE,
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignExecutionService,
        { provide: getRepositoryToken(Campaign), useValue: campaigns },
        {
          provide: getRepositoryToken(CampaignRecipient),
          useValue: recipients,
        },
        { provide: CampaignRunService, useValue: runs },
        { provide: DataSource, useValue: dataSource },
        { provide: WhatsappMessageRouter, useValue: whatsappRouter },
        { provide: WhatsappTemplateService, useValue: templates },
        {
          provide: TenantContextService,
          useValue: { getCorrelationId: () => 'cid-1' },
        },
        { provide: CustomerSegmentService, useValue: segments },
        { provide: CampaignAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(CampaignExecutionService);
  });

  describe('assertSendable — channel branching (T131)', () => {
    it('an EMAIL campaign with subject+body skips the WhatsApp WABA/template/number chain entirely', async () => {
      await service.launch(TENANT, CAMPAIGN_ID, { force: true } as never);
      expect(whatsappRouter.resolveForSend).not.toHaveBeenCalled();
      expect(templates.getSendableTemplate).not.toHaveBeenCalled();
    });

    it('an EMAIL campaign missing a subject/body is rejected before touching the run/outbox', async () => {
      campaigns.findOne.mockResolvedValueOnce({
        ...baseCampaign,
        email_subject: null,
      });

      await expect(
        service.launch(TENANT, CAMPAIGN_ID, { force: true } as never),
      ).rejects.toBeInstanceOf(AppError);
      expect(runs.currentEditable).not.toHaveBeenCalled();
    });

    it('a WHATSAPP campaign still goes through the WABA/template preflight (unchanged)', async () => {
      const whatsappCampaign = {
        ...baseCampaign,
        channel: 'WHATSAPP',
        template: { id: 'tpl-1' },
      };
      campaigns.findOne.mockResolvedValue(whatsappCampaign);
      manager.findOne.mockResolvedValue(whatsappCampaign);
      whatsappRouter.resolveForSend.mockResolvedValueOnce({
        wabaId: undefined,
      });
      templates.getSendableTemplate.mockResolvedValueOnce({
        waba_id: undefined,
        name: 'tpl',
      });

      await service.launch(TENANT, CAMPAIGN_ID, { force: true } as never);
      expect(whatsappRouter.resolveForSend).toHaveBeenCalled();
      expect(templates.getSendableTemplate).toHaveBeenCalled();
    });
  });

  describe('T139 — audit on launch', () => {
    it('records campaign.launched with the campaign id, tenant, run id and channel — no recipient data', async () => {
      await service.launch(TENANT, CAMPAIGN_ID, { force: true } as never);

      expect(audit.record).toHaveBeenCalledWith(
        CAMPAIGN_AUDIT_ACTION.LAUNCHED,
        TENANT,
        CAMPAIGN_ID,
        expect.objectContaining({ runId: 'run-1', channel: 'EMAIL' }),
      );
    });
  });

  describe('T137 — pre-launch cap warning (never a block)', () => {
    it('warns when the resolved audience exceeds the daily cap, but still launches', async () => {
      const capped = { ...baseCampaign, daily_cap: 1 };
      campaigns.findOne.mockResolvedValue(capped);
      manager.findOne.mockResolvedValue(capped);
      manager.count = jest.fn().mockResolvedValue(5); // audience of 5 > cap of 1
      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      const result = await service.launch(TENANT, CAMPAIGN_ID, {
        force: true,
      } as never);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('daily cap'),
      );
      expect(result).toBeDefined(); // launch still completes
    });

    it('does not warn when the audience is within both caps', async () => {
      const capped = { ...baseCampaign, daily_cap: 100, monthly_cap: 1000 };
      campaigns.findOne.mockResolvedValue(capped);
      manager.findOne.mockResolvedValue(capped);
      manager.count = jest.fn().mockResolvedValue(3);
      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      await service.launch(TENANT, CAMPAIGN_ID, { force: true } as never);

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('cap'));
    });
  });
});
