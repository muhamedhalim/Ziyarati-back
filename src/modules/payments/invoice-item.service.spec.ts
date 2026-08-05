import { InvoiceItemService } from './invoice-item.service';
import { InvoiceItem } from '../../entities/Payments/InvoiceItem';
import { Invoice } from '../../entities/Payments/Invoice';
import { createMockRepository, createMockEntityManager, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const INVOICE = 'inv-1';

/**
 * FND-029 — `recalcTotal` sums `total_price` as JS floating-point major
 * units, then rounds once at the end (`round2(items.reduce((s,it) =>
 * s+Number(it.total_price), 0))`). FR-B005 requires integer-minor-unit
 * aggregation instead.
 *
 * INVESTIGATION (recorded honestly — this finding does NOT reproduce as an
 * observable wrong FINAL total in this codebase's actual runtime): searched
 * >2,000,000 random invoices (2-1000 line items, random 2-decimal prices)
 * plus a targeted hill-climbing search explicitly maximizing the float-sum
 * vs integer-cents divergence — zero cases where `round2(floatSum)` produced
 * an incorrect final total. The worst discovered raw (pre-round) error was
 * ~6e-8 cents — about 7 orders of magnitude below the 0.5-cent threshold
 * that would need crossing to flip a rounding decision. This matches IEEE
 * 754 double precision (~15-17 significant decimal digits) applied to
 * invoice-scale sums: the failure mode is real in principle (and in other
 * languages/precisions) but not practically triggerable here.
 *
 * What IS concretely, mechanically true today (RED, recorded below): the
 * RAW pre-round sum is not bit-exact vs the integer-cents-derived value —
 * e.g. `81.45 + 134.27 === 215.72000000000003`, not `215.72` — so the
 * current implementation relies on `round2` happening to mask that noise,
 * rather than being exact by construction. The fix (integer-cents
 * summation) is exact by construction, not empirically-usually-correct, and
 * costs nothing — implemented regardless of the failure being triggerable.
 */
describe('InvoiceItemService.recalcTotal (FND-029)', () => {
  let service: InvoiceItemService;
  let items: MockRepository;
  let manager: ReturnType<typeof createMockEntityManager>;

  beforeEach(() => {
    items = createMockRepository();
    manager = createMockEntityManager();
    service = new InvoiceItemService(items as unknown as any);
  });

  function itemsOf(totalPrices: string[]) {
    return totalPrices.map((p, i) => ({ id: `item-${i}`, total_price: p }));
  }

  it('RED (documented, not asserted as a failure — see class docstring): the raw pre-round sum is not bit-exact for a known adversarial pair', () => {
    // Concrete, deterministic proof the AGGREGATION METHOD is imprecise by
    // construction, independent of whether round2 happens to mask it.
    const raw = 81.45 + 134.27;
    expect(raw).not.toBe(215.72);
    expect(raw.toString()).toBe('215.72000000000003');
  });

  it('sums a many-line invoice to the exact integer-cents-derived total (the adversarial pair, among 6 items)', async () => {
    const prices = ['81.45', '134.27', '19.99', '5.01', '0.01', '999.98'];
    manager.getRepository = jest.fn(() => {
      const repo = createMockRepository();
      repo.find.mockResolvedValue(itemsOf(prices));
      return repo as unknown as ReturnType<typeof manager.getRepository>;
    }) as typeof manager.getRepository;

    const total = await service.recalcTotal(TENANT, INVOICE, manager as any);

    const exactCents = prices.reduce((s, p) => s + Math.round(Number(p) * 100), 0);
    expect(total).toBe(exactCents / 100);
    expect(total).toBe(1240.71);
  });

  it('sums 200 line items to the exact integer-cents-derived total (many-line invoice)', async () => {
    const prices: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const cents = 1 + ((i * 9973) % 999999); // deterministic pseudo-random spread
      prices.push((cents / 100).toFixed(2));
    }
    manager.getRepository = jest.fn(() => {
      const repo = createMockRepository();
      repo.find.mockResolvedValue(itemsOf(prices));
      return repo as unknown as ReturnType<typeof manager.getRepository>;
    }) as typeof manager.getRepository;

    const total = await service.recalcTotal(TENANT, INVOICE, manager as any);

    const exactCents = prices.reduce((s, p) => s + Math.round(Number(p) * 100), 0);
    expect(total).toBe(exactCents / 100);
  });

  it('writes the recalculated total onto the parent invoice', async () => {
    const updateFn = jest.fn().mockResolvedValue({ affected: 1 });
    manager.getRepository = jest.fn((entity: unknown) => {
      if (entity === InvoiceItem) {
        const repo = createMockRepository();
        repo.find.mockResolvedValue(itemsOf(['10.00', '5.50']));
        return repo as unknown as ReturnType<typeof manager.getRepository>;
      }
      if (entity === Invoice) {
        return { update: updateFn } as unknown as ReturnType<typeof manager.getRepository>;
      }
      throw new Error(`unexpected entity ${String(entity)}`);
    }) as typeof manager.getRepository;

    const total = await service.recalcTotal(TENANT, INVOICE, manager as any);

    expect(total).toBe(15.5);
    expect(updateFn).toHaveBeenCalledWith({ id: INVOICE }, { total_amount: 15.5 });
  });
});
