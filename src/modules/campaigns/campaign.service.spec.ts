import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CampaignService } from './campaign.service';
import { Campaign } from '../../entities/Campaigns/Campaign';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { UsageService } from '../subscription-billing/usage.service';
import { CampaignLifecycle } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';

describe('CampaignService', () => {
  let service: CampaignService;
  let campaigns: MockRepository;
  let templates: MockRepository;
  let accounts: MockRepository;
  let usage: { assertWithinLimit: jest.Mock; increment: jest.Mock };

  beforeEach(async () => {
    campaigns = createMockRepository();
    templates = createMockRepository();
    templates.exists.mockResolvedValue(true);
    accounts = createMockRepository();
    accounts.exists.mockResolvedValue(true);
    usage = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignService,
        { provide: getRepositoryToken(Campaign), useValue: campaigns },
        { provide: getRepositoryToken(WhatsappTemplate), useValue: templates },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: UsageService, useValue: usage },
      ],
    }).compile();
    service = moduleRef.get(CampaignService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('enforces quota, creates a DRAFT, and counts usage', async () => {
      campaigns.save.mockResolvedValueOnce({ id: 'camp1' });
      campaigns.findOne.mockResolvedValueOnce({ id: 'camp1' });
      await service.create(TENANT, USER, { name: 'Promo', templateId: 'tpl1' } as any);
      expect(usage.assertWithinLimit).toHaveBeenCalledWith(TENANT, 'CAMPAIGNS', 1);
      expect(usage.increment).toHaveBeenCalledWith(TENANT, 'CAMPAIGNS', 1);
      const created = campaigns.create.mock.calls[0][0];
      expect(created.lifecycle).toBe(CampaignLifecycle.DRAFT);
    });

    it('rejects a template not in the tenant with 422', async () => {
      templates.exists.mockResolvedValueOnce(false);
      await expect(service.create(TENANT, USER, { name: 'x', templateId: 'bad' } as any)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('update', () => {
    it('refuses to edit a non-editable lifecycle', async () => {
      campaigns.findOne.mockResolvedValueOnce({ id: 'camp1', lifecycle: CampaignLifecycle.ACTIVE });
      await expect(service.update(TENANT, 'camp1', { name: 'x' } as any)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('edits a DRAFT campaign', async () => {
      campaigns.findOne.mockResolvedValue({ id: 'camp1', lifecycle: CampaignLifecycle.DRAFT });
      await service.update(TENANT, 'camp1', { name: 'New' } as any);
      expect(campaigns.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }));
    });
  });

  describe('lifecycle ops', () => {
    it('findOne throws for an unknown campaign', async () => {
      campaigns.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('archive soft-hides and sets ARCHIVED lifecycle', async () => {
      campaigns.findOne.mockResolvedValueOnce({ id: 'camp1', lifecycle: CampaignLifecycle.DRAFT });
      campaigns.save.mockImplementationOnce(async (c: any) => c);
      const res = await service.archive(TENANT, 'camp1');
      expect(res.lifecycle).toBe(CampaignLifecycle.ARCHIVED);
      expect(res.deleted_at).toBeInstanceOf(Date);
    });

    it('remove hard-deletes', async () => {
      campaigns.findOne.mockResolvedValueOnce({ id: 'camp1' });
      await service.remove(TENANT, 'camp1');
      expect(campaigns.delete).toHaveBeenCalledWith({ id: 'camp1' });
    });

    it('duplicate clones config into a new DRAFT', async () => {
      campaigns.findOne
        .mockResolvedValueOnce({ id: 'camp1', name: 'Promo', type: 'PROMOTION', segment: {}, throttle_per_minute: 30 })
        .mockResolvedValueOnce({ id: 'camp2' });
      campaigns.save.mockResolvedValueOnce({ id: 'camp2' });
      await service.duplicate(TENANT, USER, 'camp1');
      const copy = campaigns.create.mock.calls[0][0];
      expect(copy.name).toBe('Promo (Copy)');
      expect(copy.lifecycle).toBe(CampaignLifecycle.DRAFT);
    });
  });
});
