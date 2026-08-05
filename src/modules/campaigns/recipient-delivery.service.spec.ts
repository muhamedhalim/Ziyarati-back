import { RecipientDeliveryService } from './recipient-delivery.service';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { RecipientDelivery } from '../../entities/enums';

function buildQueryBuilder() {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
  qb.execute = jest.fn().mockResolvedValue(undefined);
  return qb;
}

/**
 * FND-004 — the receipt route relied purely on `provider_ref` uniqueness,
 * with no tenant check anywhere in the lookup: a caller who knows/guesses
 * another tenant's `provider_ref` could flip that tenant's delivery status
 * out of band. Every test here passes a `tenantId` and proves the recipient
 * lookup is scoped to it.
 */
describe('RecipientDeliveryService — FND-004 tenant-scoped receipt matching', () => {
  let service: RecipientDeliveryService;
  let manager: { findOne: jest.Mock; update: jest.Mock; createQueryBuilder: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    manager = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => buildQueryBuilder()),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    service = new RecipientDeliveryService(dataSource as never);
  });

  it('scopes the provider_ref lookup to the caller tenant, in the SAME query (not a post-hoc check)', async () => {
    manager.findOne.mockResolvedValueOnce(null);
    await service.recordDelivery({
      providerRef: 'wamid.foreign',
      event: RecipientDelivery.DELIVERED,
      tenantId: 'tenant-a',
    });
    expect(manager.findOne).toHaveBeenCalledWith(
      CampaignRecipient,
      expect.objectContaining({
        where: expect.objectContaining({
          provider_ref: 'wamid.foreign',
          run: { tenant: { id: 'tenant-a' } },
        }),
      }),
    );
  });

  it('a foreign-tenant provider_ref is refused (recipient-not-found, not applied)', async () => {
    // The tenant-scoped query finds nothing for tenant-a, even though the
    // row genuinely exists (for tenant-b) — exactly like every other
    // tenant-isolated lookup in this codebase: cross-tenant = "not found".
    manager.findOne.mockResolvedValueOnce(null);
    const result = await service.recordDelivery({
      providerRef: 'wamid.belongs-to-tenant-b',
      event: RecipientDelivery.DELIVERED,
      tenantId: 'tenant-a',
    });
    expect(result).toEqual({ updated: false, reason: 'recipient-not-found' });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('a same-tenant receipt still succeeds', async () => {
    manager.findOne.mockResolvedValueOnce({
      id: 'rec-1',
      delivery: RecipientDelivery.NONE,
      run: { id: 'run-1' },
    });
    const result = await service.recordDelivery({
      providerRef: 'wamid.mine',
      event: RecipientDelivery.DELIVERED,
      tenantId: 'tenant-a',
    });
    expect(result).toEqual({ updated: true, delivery: RecipientDelivery.DELIVERED });
  });
});
