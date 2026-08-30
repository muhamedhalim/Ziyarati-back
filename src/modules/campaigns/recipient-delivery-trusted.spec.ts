import { RecipientDeliveryService } from './recipient-delivery.service';
import { RecipientDelivery } from '../../entities/enums';

/**
 * Phase 11 (US7, T136) — `recordDeliveryTrusted`, the seam the (signature-
 * verified) bounce/complaint webhook uses. Separate file from
 * `recipient-delivery.service.spec.ts` because this method needs a
 * `dataSource.getRepository(...).findOne(...)` mock shape that file's
 * `dataSource` stub (transaction-only) does not provide.
 */
describe('RecipientDeliveryService.recordDeliveryTrusted', () => {
  let service: RecipientDeliveryService;
  let findOne: jest.Mock;
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(() => {
    findOne = jest.fn();
    manager = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
        qb.execute = jest.fn().mockResolvedValue(undefined);
        return qb;
      }),
    };
    dataSource = {
      getRepository: jest.fn(() => ({ findOne })),
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    service = new RecipientDeliveryService(dataSource as never);
  });

  it('resolves the tenant and email from the recipient row matched by provider_ref (never the webhook payload)', async () => {
    findOne.mockResolvedValueOnce({
      id: 'rec-1',
      email: 'stored@example.com',
      customer: { email: 'customer@example.com' },
      run: { id: 'run-1', tenant: { id: 'tenant-a' } },
    });
    // The inner recordDelivery's own manager.findOne (tenant-scoped) also needs a match.
    manager.findOne.mockResolvedValueOnce({
      id: 'rec-1',
      run: { id: 'run-1', tenant: { id: 'tenant-a' } },
    });

    const result = await service.recordDeliveryTrusted(
      'resend-msg-1',
      RecipientDelivery.BOUNCED,
    );

    expect(result.tenantId).toBe('tenant-a');
    expect(result.email).toBe('stored@example.com');
    expect(result.updated).toBe(true);
  });

  it('falls back to customer.email when the recipient snapshot has none', async () => {
    findOne.mockResolvedValueOnce({
      id: 'rec-1',
      email: null,
      customer: { email: 'customer@example.com' },
      run: { id: 'run-1', tenant: { id: 'tenant-a' } },
    });
    manager.findOne.mockResolvedValueOnce({
      id: 'rec-1',
      run: { id: 'run-1', tenant: { id: 'tenant-a' } },
    });

    const result = await service.recordDeliveryTrusted(
      'resend-msg-1',
      RecipientDelivery.BOUNCED,
    );
    expect(result.email).toBe('customer@example.com');
  });

  it('returns recipient-not-found for an unknown provider_ref, without touching anything', async () => {
    findOne.mockResolvedValueOnce(null);
    const result = await service.recordDeliveryTrusted(
      'unknown-ref',
      RecipientDelivery.BOUNCED,
    );
    expect(result).toEqual({ updated: false, reason: 'recipient-not-found' });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('returns missing-provider-ref for an empty ref without querying', async () => {
    const result = await service.recordDeliveryTrusted(
      '',
      RecipientDelivery.BOUNCED,
    );
    expect(result).toEqual({ updated: false, reason: 'missing-provider-ref' });
    expect(findOne).not.toHaveBeenCalled();
  });
});
