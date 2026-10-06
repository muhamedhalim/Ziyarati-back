import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerAiRepliesService } from './customer-ai-replies.service';
import { Customer } from '../../entities/CRM/Customer';
import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { ErrorCode } from '../../common/errors';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';
const CUST = 'c1';

describe('CustomerAiRepliesService', () => {
  let service: CustomerAiRepliesService;
  let repo: MockRepository;
  let qb: ReturnType<typeof createMockQueryBuilder>;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    repo = createMockRepository();
    qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: 1 });
    repo.createQueryBuilder.mockReturnValue(qb);
    repo.findOne.mockResolvedValue({
      id: CUST,
      ai_replies_disabled: false,
      ai_replies_disabled_at: null,
    });
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerAiRepliesService,
        { provide: getRepositoryToken(Customer), useValue: repo },
        { provide: ActivityAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(CustomerAiRepliesService);
  });

  it('excludes a patient with one tenant-scoped UPDATE and stamps the time', async () => {
    const state = await service.setDisabled(TENANT, USER, CUST, true);

    expect(qb.set).toHaveBeenCalledWith({
      ai_replies_disabled: true,
      ai_replies_disabled_at: expect.any(Date),
    });
    expect(qb.where).toHaveBeenCalledWith('id = :id', { id: CUST });
    expect(qb.andWhere).toHaveBeenCalledWith('"tenantId" = :tenantId', {
      tenantId: TENANT,
    });
    expect(state).toEqual({
      id: CUST,
      aiRepliesDisabled: true,
      aiRepliesDisabledAt: expect.any(Date),
    });
  });

  it('allows the AI again and clears the time', async () => {
    repo.findOne.mockResolvedValue({
      id: CUST,
      ai_replies_disabled: true,
      ai_replies_disabled_at: new Date(),
    });

    const state = await service.setDisabled(TENANT, USER, CUST, false);

    expect(qb.set).toHaveBeenCalledWith({
      ai_replies_disabled: false,
      ai_replies_disabled_at: null,
    });
    expect(state).toEqual({
      id: CUST,
      aiRepliesDisabled: false,
      aiRepliesDisabledAt: null,
    });
  });

  it('writes only the two AI columns — never another field of the customer', async () => {
    await service.setDisabled(TENANT, USER, CUST, true);

    const set = qb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(set).sort()).toEqual([
      'ai_replies_disabled',
      'ai_replies_disabled_at',
    ]);
  });

  it('audits the change under the acting user, with ids and the flag only', async () => {
    await service.setDisabled(TENANT, USER, CUST, true);

    expect(audit.record).toHaveBeenCalledWith({
      tenantId: TENANT,
      actorUserId: USER,
      action: 'customer.ai_replies_disabled',
      entityType: 'customer',
      entityId: CUST,
      before: { ai_replies_disabled: false },
      after: { ai_replies_disabled: true },
    });
  });

  it('audits the re-enable under its own action', async () => {
    repo.findOne.mockResolvedValue({ id: CUST, ai_replies_disabled: true });

    await service.setDisabled(TENANT, USER, CUST, false);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'customer.ai_replies_enabled' }),
    );
  });

  it('is idempotent: setting the state the patient already has writes and audits nothing', async () => {
    const state = await service.setDisabled(TENANT, USER, CUST, false);

    expect(qb.execute).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(state.aiRepliesDisabled).toBe(false);
  });

  it('looks the patient up inside the caller’s tenant, and 404s for another clinic’s', async () => {
    repo.findOne.mockResolvedValue(null);

    await expect(
      service.setDisabled(TENANT, USER, 'foreign', true),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'foreign', tenant: { id: TENANT } },
      }),
    );
    expect(qb.execute).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
