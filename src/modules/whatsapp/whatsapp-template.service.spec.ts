import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { WHATSAPP_TEMPLATE_STATUS } from './whatsapp.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('WhatsappTemplateService', () => {
  let service: WhatsappTemplateService;
  let templates: MockRepository;
  let accounts: MockRepository;

  beforeEach(async () => {
    templates = createMockRepository();
    accounts = createMockRepository();
    accounts.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappTemplateService,
        { provide: getRepositoryToken(WhatsappTemplate), useValue: templates },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
      ],
    }).compile();
    service = moduleRef.get(WhatsappTemplateService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a template (no duplicate name+language)', async () => {
    templates.findOne.mockResolvedValueOnce(null);
    templates.save.mockResolvedValueOnce({ id: 'tpl1' });
    await expect(service.create(TENANT, { name: 'welcome', language: 'en' } as any)).resolves.toEqual({ id: 'tpl1' });
  });

  it('rejects a duplicate name+language', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'existing' });
    await expect(service.create(TENANT, { name: 'welcome', language: 'en' } as any)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('rejects an account not in the tenant with 422', async () => {
    accounts.exists.mockResolvedValueOnce(false);
    await expect(service.create(TENANT, { name: 'x', language: 'en', accountId: 'bad' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('setStatus rejects an invalid status', async () => {
    await expect(service.setStatus(TENANT, 'tpl1', 'bogus')).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('setStatus applies a valid, tenant-settable status', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: 'DRAFT' });
    templates.save.mockImplementationOnce(async (t: any) => t);
    // GAP-002 corrected this test: it used to assert APPROVED was settable
    // here — that WAS the vulnerability (see the describe block below). Any
    // OTHER status remains freely tenant-settable, e.g. DISABLED (hide a
    // template from use without deleting it).
    const res = await service.setStatus(TENANT, 'tpl1', WHATSAPP_TEMPLATE_STATUS.DISABLED);
    expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.DISABLED);
  });

  // ─────────────────── GAP-002: centralized transition guard ────────────────
  describe('GAP-002 — `approved` is reachable only via the Meta provider callback', () => {
    it('setStatus refuses to set APPROVED directly', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: 'PENDING_REVIEW' });
      await expect(
        service.setStatus(TENANT, 'tpl1', WHATSAPP_TEMPLATE_STATUS.APPROVED),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('update() refuses to set APPROVED directly', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: 'PENDING_REVIEW' });
      await expect(
        service.update(TENANT, 'tpl1', { status: WHATSAPP_TEMPLATE_STATUS.APPROVED } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('create() refuses to set APPROVED directly', async () => {
      templates.findOne.mockResolvedValueOnce(null); // no duplicate
      await expect(
        service.create(TENANT, {
          name: 'welcome',
          language: 'en',
          status: WHATSAPP_TEMPLATE_STATUS.APPROVED,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(templates.save).not.toHaveBeenCalled();
    });
  });

  it('getSendableTemplate requires APPROVED status', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: WHATSAPP_TEMPLATE_STATUS.DRAFT });
    await expect(service.getSendableTemplate(TENANT, 'tpl1')).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });

    templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: WHATSAPP_TEMPLATE_STATUS.APPROVED });
    await expect(service.getSendableTemplate(TENANT, 'tpl1')).resolves.toMatchObject({ id: 'tpl1' });
  });

  it('remove soft-removes the template', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1' });
    await service.remove(TENANT, 'tpl1');
    expect(templates.softRemove).toHaveBeenCalled();
  });
});
