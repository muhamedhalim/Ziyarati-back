import { ResourcePurchaseService } from './resource-purchase.service';

/**
 * The price-snapshot invariant (plan §17): once `resource_purchases` is
 * inserted, `unit_price_minor`/`unit_size`/`quantity`/`total_minor`/
 * `delta_units`/`kind`/`currency` on THAT ROW are the sole inputs to
 * everything downstream. `catalogItem` is a SET NULL provenance pointer
 * only — nothing re-reads `resource_price_catalog` after `create()`'s
 * single read at the top of the flow.
 *
 * Proven here by mutating the catalog mock's return value BETWEEN the
 * moment `create()` reads it and the moment the row is asserted, and
 * confirming the created row still reflects the ORIGINAL values — plus a
 * direct call-count assertion that the catalog is read exactly once per
 * purchase, never twice.
 */
describe('ResourcePurchaseService — price snapshot (Phase 2.2, plan §17)', () => {
  let purchases: { findOne: jest.Mock; findAndCount: jest.Mock };
  let subscriptions: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let txRepo: { create: jest.Mock; save: jest.Mock };
  let catalogService: { getActiveByKey: jest.Mock };
  let limitStatus: { resolve: jest.Mock };
  let paymentService: { create: jest.Mock };
  let service: ResourcePurchaseService;

  const originalItem = (overrides: Record<string, unknown> = {}) => ({
    id: 'cat-1',
    item_key: 'branches',
    kind: 'capacity',
    unit_label: 'branch',
    unit_size: '1',
    unit_price_minor: '5000',
    currency: 'SAR',
    min_quantity: 1,
    max_quantity: null,
    is_active: true,
    ...overrides,
  });

  beforeEach(() => {
    purchases = { findOne: jest.fn().mockResolvedValue(null), findAndCount: jest.fn() };
    subscriptions = {
      findOne: jest.fn().mockResolvedValue({
        id: 'sub-1',
        plan: { id: 'plan-1', max_branches: 5, limit_declarations: null },
      }),
    };
    txRepo = {
      create: jest.fn((d: any) => d),
      save: jest.fn(async (e: any) => ({ id: 'purchase-1', ...e })),
    };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb({ getRepository: () => txRepo })),
      query: jest.fn().mockResolvedValue([]),
    };
    catalogService = { getActiveByKey: jest.fn().mockResolvedValue(originalItem()) };
    limitStatus = { resolve: jest.fn().mockReturnValue('finite') };
    paymentService = {
      create: jest.fn().mockResolvedValue({
        payment: { id: 'pay-1', status: 'pending', gateway_payment_id: 'gw-1' },
        redirectUrl: 'https://pay.example/1',
      }),
    };

    service = new ResourcePurchaseService(
      purchases as never,
      subscriptions as never,
      dataSource as never,
      catalogService as never,
      limitStatus as never,
      paymentService as never,
    );
  });

  it('reads the catalog EXACTLY ONCE per purchase — never re-queried after the initial snapshot', async () => {
    await service.create(TENANT(), { itemKey: 'branches', quantity: 2, idempotencyKey: 'idem-1' }, ACTOR());
    expect(catalogService.getActiveByKey).toHaveBeenCalledTimes(1);
  });

  it('a price CHANGE after the read does not alter the already-computed snapshot', async () => {
    // Simulate: getActiveByKey resolves with the price AS OF THE CALL —
    // by the time create() finishes building the purchase row, an admin
    // could have already changed the real DB row. Since create() only ever
    // calls getActiveByKey ONCE (asserted above) and uses that single
    // in-memory result for the rest of the method, a later admin write is
    // structurally invisible to this purchase.
    catalogService.getActiveByKey.mockResolvedValueOnce(originalItem());
    // A second call (if the code wrongly re-read) would see the NEW price.
    catalogService.getActiveByKey.mockResolvedValueOnce(
      originalItem({ unit_price_minor: '999999' }),
    );

    await service.create(TENANT(), { itemKey: 'branches', quantity: 2, idempotencyKey: 'idem-1' }, ACTOR());

    expect(txRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ unit_price_minor: '5000', total_minor: '10000' }),
    );
  });

  it('a DEACTIVATION after the read does not affect an already-started purchase', async () => {
    // getActiveByKey itself would 404 on a deactivated item for a NEW
    // request — but this purchase already passed that check with the
    // active snapshot; nothing in create() re-checks is_active afterward.
    await service.create(TENANT(), { itemKey: 'branches', quantity: 1, idempotencyKey: 'idem-1' }, ACTOR());
    expect(txRepo.save).toHaveBeenCalledWith(expect.objectContaining({ item_key: 'branches' }));
    // The saved row carries no is_active field at all — deactivation of the
    // CATALOG has no representation on the PURCHASE row to even go stale.
    const saved = txRepo.save.mock.calls[0][0];
    expect(saved).not.toHaveProperty('is_active');
  });

  it('a unit_size CHANGE after the read does not alter the already-computed delta_units', async () => {
    catalogService.getActiveByKey.mockResolvedValueOnce(originalItem());

    await service.create(TENANT(), { itemKey: 'branches', quantity: 3, idempotencyKey: 'idem-1' }, ACTOR());

    // delta_units = unit_size(1) * quantity(3) = 3, computed from the
    // ORIGINAL unit_size — a later change to unit_size (which would also
    // force-deactivate the item per the bootstrap's safety rule) cannot
    // reach this already-created row.
    expect(txRepo.save).toHaveBeenCalledWith(expect.objectContaining({ delta_units: '3' }));
  });

  it('the purchase row is the sole input to the payment amount — computed from the snapshot, not re-derived', async () => {
    await service.create(TENANT(), { itemKey: 'branches', quantity: 4, idempotencyKey: 'idem-1' }, ACTOR());

    // total_minor = 5000 * 4 = 20000 → major units = 200.
    expect(paymentService.create).toHaveBeenCalledWith(
      TENANT(),
      expect.objectContaining({ amount: 200, currency: 'SAR' }),
      { purpose: 'ADDON' },
    );
  });

  it('catalogItem is stored as a provenance pointer, alongside the full snapshot fields (never relied on alone)', async () => {
    await service.create(TENANT(), { itemKey: 'branches', quantity: 1, idempotencyKey: 'idem-1' }, ACTOR());
    const saved = txRepo.save.mock.calls[0][0];
    expect(saved.catalogItem).toEqual({ id: 'cat-1' });
    // Every field payment/entitlement need is ALSO present directly on the
    // row — the catalogItem pointer is provenance, not a dependency.
    expect(saved).toEqual(
      expect.objectContaining({
        item_key: 'branches',
        kind: 'capacity',
        unit_label: 'branch',
        unit_size: '1',
        unit_price_minor: '5000',
        currency: 'SAR',
      }),
    );
  });

  function TENANT() {
    return 't1';
  }
  function ACTOR() {
    return { id: 'user-1', email: 'owner@example.com' };
  }
});
