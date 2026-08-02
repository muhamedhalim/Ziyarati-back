import { CampaignAnalyticsService } from './campaign-analytics.service';
import {
  createMockQueryBuilder,
  createMockRepository,
} from '../../../test/utils/mock-factories';

describe('CampaignAnalyticsService clinic identity', () => {
  it('returns the authenticated clinic name instead of its internal tenant ID', async () => {
    const campaigns = createMockRepository();
    const runs = createMockRepository();
    const tenants = createMockRepository();
    const campaignQuery = createMockQueryBuilder();
    const runQuery = createMockQueryBuilder();
    campaigns.createQueryBuilder.mockReturnValue(campaignQuery);
    runs.createQueryBuilder.mockReturnValue(runQuery);
    tenants.findOne.mockResolvedValueOnce({
      id: 'tenant-a',
      name: 'Al Noor Clinic',
    });
    campaignQuery.getRawMany.mockResolvedValueOnce([
      { lifecycle: 'DRAFT', count: '2' },
    ]);
    runQuery.getRawOne.mockResolvedValueOnce({
      total: '10',
      sent: '8',
      delivered: '7',
      read: '2',
      failed: '1',
      skipped: '1',
    });

    const service = new CampaignAnalyticsService(
      campaigns as never,
      runs as never,
      tenants as never,
    );
    const result = await service.dashboard('tenant-a');

    expect(result).toEqual(
      expect.objectContaining({
        clinicName: 'Al Noor Clinic',
        totalCampaigns: 2,
      }),
    );
    expect(result).not.toHaveProperty('tenantId');
    expect(tenants.findOne).toHaveBeenCalledWith({
      where: { id: 'tenant-a' },
      select: { id: true, name: true },
    });
  });
});
