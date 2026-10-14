import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SettlementService } from './settlement.service';
import { Settlement } from '../../entities/Payments/Settlement';
import { Payment } from '../../entities/Payments/Payment';
import { PayoutStatus } from '../../entities/enums';
import { SettlementItemService } from './settlement-item.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * VER-010 (REQ-PAY-031) — settlement generation had ZERO prior test coverage
 * of any kind (no settlement*.spec.ts existed anywhere in this module).
 */
describe('SettlementService.generate (VER-010)', () => {
  let service: SettlementService;
  let settlements: MockRepository;
  let payments: MockRepository & { metadata: unknown };
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let itemsService: { mapPayments: jest.Mock; listForSettlement: jest.Mock };
  let adjustments: { lockOpen: jest.Mock; markApplied: jest.Mock };

  beforeEach(async () => {
    settlements = createMockRepository();
    payments = createMockRepository() as any;
    // TypeORM's real naming default for an unadorned `@ManyToOne` relation —
    // `generate()` reads this via `this.payments.metadata`, which a plain
    // repository mock does not otherwise provide.
    payments.metadata = {
      findRelationWithPropertyPath: (name: string) => ({
        joinColumns: [{ databaseName: name === 'tenant' ? 'tenantId' : 'branchId' }],
      }),
    };
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    itemsService = { mapPayments: jest.fn().mockResolvedValue(undefined), listForSettlement: jest.fn().mockResolvedValue([]) };
    adjustments = {
      lockOpen: jest.fn().mockResolvedValue({ ids: [], totalCents: 0 }),
      markApplied: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SettlementService,
        { provide: getRepositoryToken(Settlement), useValue: settlements },
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: DataSource, useValue: dataSource },
        { provide: SettlementItemService, useValue: itemsService },
        { provide: SettlementAdjustmentService, useValue: adjustments },
      ],
    }).compile();
    service = moduleRef.get(SettlementService);
  });

  afterEach(() => jest.clearAllMocks());

  function claimedPayments(rows: Array<{ id: string; amount: string; currency?: string; gateway_fee?: string | null; platform_fee?: string | null }>) {
    manager.createQueryBuilder.mockImplementationOnce(() => {
      const qb = createMockQueryBuilder();
      qb.execute = jest.fn().mockResolvedValue({ raw: rows.map((r) => ({ currency: 'SAR', gateway_fee: null, platform_fee: null, ...r })) });
      return qb;
    });
  }

  function mockSumRefunds(cents: number) {
    manager.query.mockResolvedValueOnce([{ sum: (cents / 100).toString() }]);
  }

  it('aggregates claimed payments into one settlement: gross = sum(amount), net = gross when no fees/refunds', async () => {
    claimedPayments([{ id: 'p1', amount: '100.00' }, { id: 'p2', amount: '50.00' }]);
    mockSumRefunds(0);
    const settlementRepo = manager.getRepository(Settlement);
    settlementRepo.save.mockImplementationOnce(async (s: any) => ({ id: 'settlement-1', ...s }));
    settlements.findOne.mockResolvedValueOnce({ id: 'settlement-1', tenant: { id: TENANT }, gross_amount: 150, net_amount: 150 });

    const result = await service.generate(TENANT, {});

    expect(settlementRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ gross_amount: 150, fee_amount: 0, net_amount: 150, status: PayoutStatus.PENDING }),
    );
    expect(result.id).toBe('settlement-1');
  });

  it('deducts the FROZEN per-payment gateway_fee + platform_fee (captured at charge time), not a recomputed figure', async () => {
    claimedPayments([{ id: 'p1', amount: '100.00', gateway_fee: '2.00', platform_fee: '5.00' }]);
    mockSumRefunds(0);
    const settlementRepo = manager.getRepository(Settlement);
    settlementRepo.save.mockImplementationOnce(async (s: any) => s);
    settlements.findOne.mockResolvedValueOnce({});

    await service.generate(TENANT, {});

    expect(settlementRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ gross_amount: 100, fee_amount: 7, net_amount: 93 }),
    );
  });

  it('deducts SUCCEEDED refunds on the claimed payments from the collectible total (net-of-refund settlement — R1)', async () => {
    claimedPayments([{ id: 'p1', amount: '100.00' }]);
    mockSumRefunds(3000); // 30.00 refunded on p1
    const settlementRepo = manager.getRepository(Settlement);
    settlementRepo.save.mockImplementationOnce(async (s: any) => s);
    settlements.findOne.mockResolvedValueOnce({});

    await service.generate(TENANT, {});

    expect(settlementRepo.save).toHaveBeenCalledWith(expect.objectContaining({ gross_amount: 100, net_amount: 70 }));
  });

  it('applies an OPEN clawback (a refund that landed after a prior settlement) even with zero newly-claimed payments', async () => {
    claimedPayments([]);
    adjustments.lockOpen.mockResolvedValueOnce({ ids: ['adj-1'], totalCents: 1500 });
    const settlementRepo = manager.getRepository(Settlement);
    settlementRepo.save.mockImplementationOnce(async (s: any) => ({ id: 'settlement-clawback', ...s }));
    settlements.findOne.mockResolvedValueOnce({});

    await service.generate(TENANT, {});

    expect(settlementRepo.save).toHaveBeenCalledWith(expect.objectContaining({ gross_amount: 0, net_amount: -15 }));
    expect(adjustments.markApplied).toHaveBeenCalledWith(manager, ['adj-1'], 'settlement-clawback');
  });

  it('FIN-010: a caller-supplied feePercent is ignored — only the frozen per-payment fees are deducted', async () => {
    claimedPayments([]);
    adjustments.lockOpen.mockResolvedValueOnce({ ids: ['adj-1'], totalCents: 1000 });
    const settlementRepo = manager.getRepository(Settlement);
    settlementRepo.save.mockImplementationOnce(async (s: any) => s);
    settlements.findOne.mockResolvedValueOnce({});

    await service.generate(TENANT, { feePercent: 10 });

    expect(settlementRepo.save).toHaveBeenCalledWith(expect.objectContaining({ fee_amount: 0, net_amount: -10 }));
  });

  it('REFUSES (422) when nothing is claimed AND there are no open clawbacks — never creates an empty settlement', async () => {
    claimedPayments([]);
    await expect(service.generate(TENANT, {})).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    const settlementRepo = manager.getRepository(Settlement);
    expect(settlementRepo.save).not.toHaveBeenCalled();
  });

  it('the claim UPDATE filters by tenant, status IN (PAID, PARTIALLY_REFUNDED), and settlement_status = UNSETTLED — never a broader claim', async () => {
    let capturedQb: ReturnType<typeof createMockQueryBuilder> | undefined;
    manager.createQueryBuilder.mockImplementationOnce(() => {
      const qb = createMockQueryBuilder();
      qb.execute = jest.fn().mockResolvedValue({ raw: [{ id: 'p1', amount: '10.00', currency: 'SAR', gateway_fee: null, platform_fee: null }] });
      capturedQb = qb;
      return qb;
    });
    mockSumRefunds(0);
    const settlementRepo = manager.getRepository(Settlement);
    settlementRepo.save.mockImplementationOnce(async (s: any) => s);
    settlements.findOne.mockResolvedValueOnce({});

    await service.generate(TENANT, {});

    expect(capturedQb!.where).toHaveBeenCalledWith(expect.stringContaining('tenantId'), { tenantId: TENANT });
    expect(capturedQb!.andWhere).toHaveBeenCalledWith(
      'status IN (:...statuses)',
      expect.objectContaining({ statuses: expect.arrayContaining(['PAID', 'PARTIALLY_REFUNDED']) }),
    );
    expect(capturedQb!.andWhere).toHaveBeenCalledWith('settlement_status = :unsettled', { unsettled: 'UNSETTLED' });
  });

  // Tap Phase 2 (plan §9) — the classification bug: the claim took EVERY PAID
  // payment of the tenant, including the clinic's own add-on / billing-upgrade
  // payments TO the platform, so they were batched as money owed back to it.
  it("the claim takes ONLY the clinic's own money that ZiyaraTech itself collected (purpose allow-list + INTERNAL mode)", async () => {
    let capturedQb: ReturnType<typeof createMockQueryBuilder> | undefined;
    manager.createQueryBuilder.mockImplementationOnce(() => {
      const qb = createMockQueryBuilder();
      qb.execute = jest.fn().mockResolvedValue({ raw: [] });
      capturedQb = qb;
      return qb;
    });

    await expect(service.generate(TENANT, {})).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });

    expect(capturedQb!.andWhere).toHaveBeenCalledWith('purpose IN (:...purposes)', {
      purposes: ['BOOKING', 'MANUAL'],
    });
    expect(capturedQb!.andWhere).toHaveBeenCalledWith(
      'settlement_mode = :internalMode',
      { internalMode: 'INTERNAL' },
    );
  });

  it('the purpose filter is a positive allow-list — platform revenue and any future purpose are never claimable', async () => {
    let capturedQb: ReturnType<typeof createMockQueryBuilder> | undefined;
    manager.createQueryBuilder.mockImplementationOnce(() => {
      const qb = createMockQueryBuilder();
      qb.execute = jest.fn().mockResolvedValue({ raw: [] });
      capturedQb = qb;
      return qb;
    });
    await service.generate(TENANT, {}).catch(() => undefined);

    const purposeCall = capturedQb!.andWhere.mock.calls.find(
      ([sql]) => sql === 'purpose IN (:...purposes)',
    );
    const purposes = purposeCall![1].purposes as string[];
    expect(purposes).not.toContain('ADDON');
    expect(purposes).not.toContain('BILLING_UPGRADE');
    expect(purposes.sort()).toEqual(['BOOKING', 'MANUAL']);
  });

  it('an optional branchId/period filter is applied as an additional andWhere, not a replacement of the base filter', async () => {
    let capturedQb: ReturnType<typeof createMockQueryBuilder> | undefined;
    manager.createQueryBuilder.mockImplementationOnce(() => {
      const qb = createMockQueryBuilder();
      qb.execute = jest.fn().mockResolvedValue({ raw: [] });
      capturedQb = qb;
      return qb;
    });

    await expect(service.generate(TENANT, { branchId: 'branch-1' })).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
    expect(capturedQb!.andWhere).toHaveBeenCalledWith(expect.stringContaining('branchId'), { branchId: 'branch-1' });
  });

  it('maps the claimed payment ids onto the new settlement via SettlementItemService, inside the SAME transaction manager', async () => {
    claimedPayments([{ id: 'p1', amount: '10.00' }, { id: 'p2', amount: '20.00' }]);
    mockSumRefunds(0);
    const settlementRepo = manager.getRepository(Settlement);
    settlementRepo.save.mockImplementationOnce(async (s: any) => ({ id: 'settlement-9', ...s }));
    settlements.findOne.mockResolvedValueOnce({});

    await service.generate(TENANT, {});

    expect(itemsService.mapPayments).toHaveBeenCalledWith('settlement-9', ['p1', 'p2'], manager);
  });
});

/**
 * UNV-001 (REQ-PAY-043, P2) — payout status integrity.
 *
 * RESOLVED, WITH A NEW FINDING RAISED (VER-ESC applies — does NOT close as
 * "fully implemented"): research.md's own Part 3 already flagged this —
 * "no payout endpoint was found in the 627-route inventory. Either payouts
 * run entirely through the settlement flow (then test that) or an
 * uninventoried mechanism exists (then the route inventory was incomplete)."
 *
 * Neither disjunct holds. A repo-wide grep for every write site of
 * `PayoutStatus.PAID`/`PayoutStatus.FAILED` (or a raw `settlement.status =`
 * assignment) anywhere in `Ziyarati-back/src/` returns ZERO matches outside
 * this entity file and this spec. `generate()` (proven above, VER-010) sets
 * `status: PayoutStatus.PENDING` at creation and NOTHING in this codebase
 * ever advances it — not to `PROCESSING`, not to `PAID`, not to `FAILED`.
 * `SettlementController` exposes exactly three routes (`generate`, `list`,
 * `get`) — no "mark paid", "process payout", or "disburse" endpoint exists
 * anywhere in the backend.
 *
 * So: the settlement flow is NOT "the sole mechanism, confirmed" (it only
 * implements batch GENERATION, not completion) — but no separate/
 * uninventoried mechanism was found either. The literal requirement "a
 * FAILED payout cannot become PAID without a new recorded attempt" is
 * vacuously true today only because NEITHER state is ever reached at all —
 * every settlement is permanently stuck at PENDING forever. This is a real
 * gap (disbursement — the platform actually paying the clinic — appears to
 * be an entirely manual, off-system process today, with no code path to
 * even RECORD that it happened), not a documentation-only closure. Building
 * the missing payout-completion mechanism (a real bank-disbursement
 * integration or, at minimum, a manual "mark settled" admin action with its
 * own audit trail) is out of Wave 4's verification scope and is raised as a
 * dedicated follow-up (see the session's completion report / spawned task).
 */
describe('Settlement payout status integrity (UNV-001)', () => {
  // A freshly generated settlement is PENDING — already asserted directly in
  // the `generate (VER-010)` block above ("aggregates claimed payments into
  // one settlement" asserts `status: PayoutStatus.PENDING` on the saved
  // row); not re-asserted here to avoid a duplicate/vacuous test.

  it('REPO-WIDE PROOF: no code path anywhere in src/ ever writes PayoutStatus.PAID or PayoutStatus.FAILED — the payout lifecycle has no completion mechanism, settlement or otherwise', () => {
    const srcRoot = path.join(__dirname, '..', '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const contents = fs.readFileSync(full, 'utf8');
          if (/PayoutStatus\.(PAID|FAILED|PROCESSING)/.test(contents)) {
            hits.push(path.relative(srcRoot, full).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(srcRoot);
    // Zero matches anywhere — the enum's own declaration (`PAID = 'PAID'`)
    // doesn't self-reference the qualified `PayoutStatus.PAID` form, so even
    // that file doesn't match this pattern.
    expect(hits).toEqual([]);
  });

  it('SettlementController exposes exactly three routes — generate, list, get — no payout-completion action exists', () => {
    const controllerSrc = fs.readFileSync(
      path.join(__dirname, 'settlement.controller.ts'),
      'utf8',
    );
    const httpDecorators = controllerSrc.match(/@(Get|Post|Patch|Put|Delete)\(/g) ?? [];
    expect(httpDecorators).toHaveLength(3);
  });
});

describe('SettlementService.getOne / findOne / list (VER-010, read paths)', () => {
  let service: SettlementService;
  let settlements: MockRepository;
  let itemsService: { mapPayments: jest.Mock; listForSettlement: jest.Mock };

  beforeEach(async () => {
    settlements = createMockRepository();
    itemsService = { mapPayments: jest.fn(), listForSettlement: jest.fn().mockResolvedValue([{ id: 'item-1' }]) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SettlementService,
        { provide: getRepositoryToken(Settlement), useValue: settlements },
        { provide: getRepositoryToken(Payment), useValue: createMockRepository() },
        { provide: DataSource, useValue: createMockDataSource() },
        { provide: SettlementItemService, useValue: itemsService },
        { provide: SettlementAdjustmentService, useValue: { lockOpen: jest.fn(), markApplied: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(SettlementService);
  });

  it('findOne is tenant-scoped — a foreign tenant\'s settlement id is NOT_FOUND', async () => {
    settlements.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'foreign-settlement')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(settlements.findOne).toHaveBeenCalledWith({ where: { id: 'foreign-settlement', tenant: { id: TENANT } } });
  });

  it('getOne composes the settlement with its mapped payment items', async () => {
    settlements.findOne.mockResolvedValueOnce({ id: 's1', tenant: { id: TENANT } });
    const result = await service.getOne(TENANT, 's1');
    expect(result.items).toEqual([{ id: 'item-1' }]);
    expect(itemsService.listForSettlement).toHaveBeenCalledWith('s1');
  });

  it('list is tenant-scoped with optional status/date filters', async () => {
    settlements.findAndCount.mockResolvedValueOnce([[], 0]);
    await service.list(TENANT, { status: PayoutStatus.PAID, page: 1, limit: 20 } as any);
    expect(settlements.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant: { id: TENANT }, status: PayoutStatus.PAID } }),
    );
  });
});
