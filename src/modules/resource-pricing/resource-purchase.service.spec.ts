import { ResourcePurchaseService } from './resource-purchase.service';
import { ErrorCode } from '../../common/errors';

const TENANT = 't1';
const ACTOR = { id: 'user-1', email: 'owner@example.com' };

function catalogItem(overrides: Record<string, unknown> = {}) {
  return {
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
  };
}

function subscriptionWithPlan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    plan: { id: 'plan-1', max_branches: 5, limit_declarations: null },
    ...overrides,
  };
}

describe('ResourcePurchaseService (Phase 2.2 — plan §16/§17/§20)', () => {
  let purchases: {
    findOne: jest.Mock;
    findAndCount: jest.Mock;
  };
  let subscriptions: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let txRepo: { create: jest.Mock; save: jest.Mock };
  let catalogService: { getActiveByKey: jest.Mock };
  let limitStatus: { resolve: jest.Mock };
  let paymentService: { create: jest.Mock };
  let service: ResourcePurchaseService;

  beforeEach(() => {
    purchases = { findOne: jest.fn().mockResolvedValue(null), findAndCount: jest.fn() };
    subscriptions = { findOne: jest.fn().mockResolvedValue(subscriptionWithPlan()) };
    txRepo = {
      create: jest.fn((d: any) => d),
      save: jest.fn(async (e: any) => ({ id: 'purchase-1', ...e })),
    };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb({ getRepository: () => txRepo })),
      query: jest.fn().mockResolvedValue([]),
    };
    catalogService = { getActiveByKey: jest.fn().mockResolvedValue(catalogItem()) };
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

  describe('preview', () => {
    it('computes total/delta from the catalog snapshot, BigInt-exact', async () => {
      catalogService.getActiveByKey.mockResolvedValueOnce(
        catalogItem({ unit_price_minor: '5000', unit_size: '1' }),
      );
      const result = await service.preview(TENANT, { itemKey: 'branches', quantity: 3 });
      expect(result.totalMinor).toBe(15000);
      expect(result.deltaUnits).toBe(3);
      expect(result.currentLimit).toBe(5);
      expect(result.resultingLimit).toBe(8);
      expect(result.currentLimitStatus).toBe('finite');
    });

    it('refuses below min_quantity', async () => {
      catalogService.getActiveByKey.mockResolvedValueOnce(catalogItem({ min_quantity: 5 }));
      await expect(
        service.preview(TENANT, { itemKey: 'branches', quantity: 1 }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('refuses above max_quantity', async () => {
      catalogService.getActiveByKey.mockResolvedValueOnce(catalogItem({ max_quantity: 2 }));
      await expect(
        service.preview(TENANT, { itemKey: 'branches', quantity: 3 }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('AI_TOKENS: accepts the minimum purchase of 50,000 tokens (50 lots × 1,000 unit_size)', async () => {
      catalogService.getActiveByKey.mockResolvedValueOnce(
        catalogItem({
          item_key: 'AI_TOKENS',
          kind: 'credit',
          unit_label: 'tokens_1k',
          unit_size: '1000',
          unit_price_minor: '500',
          min_quantity: 50,
          max_quantity: 1000,
        }),
      );
      const result = await service.preview(TENANT, { itemKey: 'AI_TOKENS', quantity: 50 });
      expect(result.deltaUnits).toBe(50000);
      expect(result.totalMinor).toBe(25000);
    });

    it('AI_TOKENS: refuses anything below the 50,000-token minimum (quantity=49 → 49,000 tokens, one lot short of min_quantity=50)', async () => {
      catalogService.getActiveByKey.mockResolvedValueOnce(
        catalogItem({
          item_key: 'AI_TOKENS',
          kind: 'credit',
          unit_label: 'tokens_1k',
          unit_size: '1000',
          unit_price_minor: '500',
          min_quantity: 50,
          max_quantity: 1000,
        }),
      );
      await expect(
        service.preview(TENANT, { itemKey: 'AI_TOKENS', quantity: 49 }),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        message: expect.stringContaining('Minimum purchase quantity for "AI_TOKENS" is 50'),
      });
    });

    it('AI_TOKENS: accepts the new million-token cap (1,000 lots) and refuses one lot beyond it', async () => {
      catalogService.getActiveByKey.mockResolvedValueOnce(
        catalogItem({
          item_key: 'AI_TOKENS',
          kind: 'credit',
          unit_label: 'tokens_1k',
          unit_size: '1000',
          unit_price_minor: '500',
          min_quantity: 50,
          max_quantity: 1000,
        }),
      );
      const result = await service.preview(TENANT, { itemKey: 'AI_TOKENS', quantity: 1000 });
      expect(result.deltaUnits).toBe(1000000);

      catalogService.getActiveByKey.mockResolvedValueOnce(
        catalogItem({
          item_key: 'AI_TOKENS',
          kind: 'credit',
          unit_label: 'tokens_1k',
          unit_size: '1000',
          unit_price_minor: '500',
          min_quantity: 50,
          max_quantity: 1000,
        }),
      );
      await expect(
        service.preview(TENANT, { itemKey: 'AI_TOKENS', quantity: 1001 }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it("refuses when the TENANT'S OWN plan already has this limit set to unlimited", async () => {
      limitStatus.resolve.mockReturnValueOnce('unlimited');
      await expect(
        service.preview(TENANT, { itemKey: 'branches', quantity: 1 }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it("refuses when the TENANT'S OWN plan has this limit not configured", async () => {
      limitStatus.resolve.mockReturnValueOnce('not_configured');
      await expect(
        service.preview(TENANT, { itemKey: 'branches', quantity: 1 }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('refuses when the tenant has no active subscription', async () => {
      subscriptions.findOne.mockResolvedValueOnce(null);
      await expect(
        service.preview(TENANT, { itemKey: 'branches', quantity: 1 }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });
  });

  describe('create', () => {
    it('creates the purchase, charges via platformRevenue, and links the payment', async () => {
      const result = await service.create(
        TENANT,
        { itemKey: 'branches', quantity: 2, idempotencyKey: 'idem-1' },
        ACTOR,
      );

      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          item_key: 'branches',
          quantity: 2,
          unit_price_minor: '5000',
          total_minor: '10000',
          delta_units: '2',
          status: 'payment_processing',
          idempotency_key: 'idem-1',
        }),
      );
      expect(paymentService.create).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          amount: 100, // 10000 minor / 100
          currency: 'SAR',
          idempotencyKey: 'rp:purchase-1',
        }),
        { platformRevenue: true },
      );
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "resource_purchases"'),
        ['pay-1', 'gw-1', 'purchase-1'],
      );
      expect(result.redirectUrl).toBe('https://pay.example/1');
      expect(result.paymentStatus).toBe('pending');
    });

    it('sets purchasedBy/purchased_by_email from the actor', async () => {
      await service.create(TENANT, { itemKey: 'branches', quantity: 1, idempotencyKey: 'idem-1' }, ACTOR);
      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          purchasedBy: { id: 'user-1' },
          purchased_by_email: 'owner@example.com',
        }),
      );
    });

    it('idempotent replay: the SAME key returns the existing purchase, no new row, no new charge', async () => {
      const existing = { id: 'purchase-existing', idempotency_key: 'idem-1', payment: null };
      purchases.findOne.mockResolvedValueOnce(existing);

      const result = await service.create(
        TENANT,
        { itemKey: 'branches', quantity: 1, idempotencyKey: 'idem-1' },
        ACTOR,
      );

      expect(result.purchase).toBe(existing);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(paymentService.create).not.toHaveBeenCalled();
    });

    it('lost the unique-key race → returns the winner, no second charge', async () => {
      dataSource.transaction.mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );
      const winner = { id: 'purchase-winner', idempotency_key: 'idem-1', payment: null };
      purchases.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);

      const result = await service.create(
        TENANT,
        { itemKey: 'branches', quantity: 1, idempotencyKey: 'idem-1' },
        ACTOR,
      );

      expect(result.purchase).toBe(winner);
      expect(paymentService.create).not.toHaveBeenCalled();
    });

    it('validates quantity range BEFORE creating anything', async () => {
      catalogService.getActiveByKey.mockResolvedValueOnce(catalogItem({ max_quantity: 1 }));
      await expect(
        service.create(TENANT, { itemKey: 'branches', quantity: 5, idempotencyKey: 'idem-1' }, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses when the tenant\'s own plan limit is not Finite, before touching the database', async () => {
      limitStatus.resolve.mockReturnValueOnce('unlimited');
      await expect(
        service.create(TENANT, { itemKey: 'branches', quantity: 1, idempotencyKey: 'idem-1' }, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('404s for a purchase belonging to another tenant (or nonexistent)', async () => {
      purchases.findOne.mockResolvedValueOnce(null);
      await expect(service.get(TENANT, 'nope')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('currentUsage (plan §19 — add-on card "current usage")', () => {
    it('runs ONE batched query and maps each capacity item to its live count', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          branches: 3,
          employees: 12,
          customers: 480,
          uploadedFiles: 90,
          knowledgeBaseFiles: 4,
          trainingFiles: 1,
        },
      ]);

      const result = await service.currentUsage(TENANT);

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const [sql, params] = dataSource.query.mock.calls[0];
      expect(sql).toMatch(/FROM "branches"/);
      expect(sql).toMatch(/FROM "users"/);
      expect(sql).toMatch(/FROM "file_uploads"/);
      expect(sql).toMatch(/FROM "ai_knowledge_bases"/);
      expect(sql).toMatch(/FROM "ai_training_files"/);
      expect(params).toEqual([TENANT]);
      // uploadedFiles/trainingFiles are byte-size caps (priced per GB) — sum
      // file_size, don't count rows. Every other capacity item stays a count.
      expect(sql).toMatch(/COALESCE\(SUM\(file_size\), 0\)::bigint FROM "file_uploads"/);
      expect(sql).toMatch(/COALESCE\(SUM\(file_size\), 0\)::bigint FROM "ai_training_files"/);
      expect(sql).toMatch(/COUNT\(\*\)::int FROM "branches"/);
      expect(sql).toMatch(/COUNT\(\*\)::int FROM "users"/);
      expect(sql).toMatch(/COUNT\(\*\)::int FROM "customers"/);
      expect(sql).toMatch(/COUNT\(\*\)::int FROM "ai_knowledge_bases"/);
      expect(result).toEqual({
        branches: 3,
        employees: 12,
        customers: 480,
        uploadedFiles: 90,
        knowledgeBaseFiles: 4,
        trainingFiles: 1,
      });
    });

    it('defaults a missing/null column to 0 rather than NaN', async () => {
      dataSource.query.mockResolvedValueOnce([{ branches: 0 }]);
      const result = await service.currentUsage(TENANT);
      expect(result.employees).toBe(0);
      expect(result.storageBytes).toBeUndefined(); // storage is blocked — not counted here
    });
  });
});
