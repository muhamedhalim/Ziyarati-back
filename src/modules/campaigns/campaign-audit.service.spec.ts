import {
  CampaignAuditService,
  CAMPAIGN_AUDIT_ACTION,
} from './campaign-audit.service';

describe('CampaignAuditService (T139)', () => {
  let auditLogs: { create: jest.Mock; save: jest.Mock };
  let service: CampaignAuditService;

  beforeEach(() => {
    auditLogs = {
      create: jest.fn((v) => v),
      save: jest.fn().mockResolvedValue(undefined),
    };
    service = new CampaignAuditService(auditLogs as never);
  });

  it('writes campaign.launched with the campaign id and tenant, entity_type Campaign', async () => {
    await service.record(CAMPAIGN_AUDIT_ACTION.LAUNCHED, 't1', 'camp-1', {
      channel: 'EMAIL',
    });
    expect(auditLogs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: { id: 't1' },
        action: 'campaign.launched',
        entity_type: 'Campaign',
        entity_id: 'camp-1',
        new_values: { channel: 'EMAIL' },
      }),
    );
  });

  it('writes campaign.unsubscribed with no recipient address anywhere in the row', async () => {
    await service.record(CAMPAIGN_AUDIT_ACTION.UNSUBSCRIBED, 't1', undefined, {
      source: 'unsubscribe_link',
    });
    const saved = auditLogs.save.mock.calls[0][0];
    expect(JSON.stringify(saved)).not.toMatch(/@/); // no email-shaped string anywhere
  });

  it('never throws when the write fails (best-effort, matches AppointmentAuditService)', async () => {
    auditLogs.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record(CAMPAIGN_AUDIT_ACTION.LAUNCHED, 't1', 'camp-1'),
    ).resolves.toBeUndefined();
  });
});
