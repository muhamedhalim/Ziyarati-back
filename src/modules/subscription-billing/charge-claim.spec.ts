import {
  CHARGE_CLAIM_AMBIGUOUS_MS,
  CHARGE_CLAIM_STALE_MS,
  chargeClaimBlocks,
  chargeClaimFree,
} from './charge-claim';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('chargeClaimBlocks', () => {
  it('no claim never blocks', () => {
    expect(chargeClaimBlocks({}, NOW)).toBe(false);
    expect(
      chargeClaimBlocks(
        { charge_started_at: null, checkout_charge_id: 'chg_1' },
        NOW,
      ),
    ).toBe(false);
  });

  it('a FRESH claim blocks, with or without a charge id', () => {
    expect(chargeClaimBlocks({ charge_started_at: ago(MIN) }, NOW)).toBe(true);
    expect(
      chargeClaimBlocks(
        { charge_started_at: ago(MIN), checkout_charge_id: 'chg_1' },
        NOW,
      ),
    ).toBe(true);
  });

  it('a stale claim with NO charge id may be retried (same idempotency key returns the original)', () => {
    expect(
      chargeClaimBlocks(
        { charge_started_at: ago(CHARGE_CLAIM_STALE_MS + MIN) },
        NOW,
      ),
    ).toBe(false);
    expect(chargeClaimBlocks({ charge_started_at: ago(19 * HOUR) }, NOW)).toBe(
      false,
    );
  });

  it('a stale claim whose charge id is KNOWN still blocks — it may capture at any moment', () => {
    expect(
      chargeClaimBlocks(
        { charge_started_at: ago(3 * HOUR), checkout_charge_id: 'chg_1' },
        NOW,
      ),
    ).toBe(true);
  });

  it('a claim with no id blocks again once the 24h idempotency window is about to lapse', () => {
    expect(
      chargeClaimBlocks(
        { charge_started_at: ago(CHARGE_CLAIM_AMBIGUOUS_MS) },
        NOW,
      ),
    ).toBe(true);
    expect(chargeClaimBlocks({ charge_started_at: ago(30 * HOUR) }, NOW)).toBe(
      true,
    );
  });
});

describe('chargeClaimFree (the SQL twin)', () => {
  it("uses namespaced params so it composes with the caller's own", () => {
    const { sql, params } = chargeClaimFree(NOW);
    expect(sql).toBe(
      '(charge_started_at IS NULL OR ' +
        '(charge_started_at < :claimStale AND checkout_charge_id IS NULL ' +
        'AND charge_started_at > :claimAmbiguous))',
    );
    expect(params.claimStale).toEqual(ago(CHARGE_CLAIM_STALE_MS));
    expect(params.claimAmbiguous).toEqual(ago(CHARGE_CLAIM_AMBIGUOUS_MS));
  });

  it('the SQL boundaries match the TypeScript rule (stale < 10 min, ambiguous >= 20h)', () => {
    const { params } = chargeClaimFree(NOW);
    // free  <=>  claimed before `claimStale` AND after `claimAmbiguous` AND no id
    const free = (age: number, id?: string) =>
      ago(age) < params.claimStale && ago(age) > params.claimAmbiguous && !id;
    for (const [age, id] of [
      [MIN, undefined],
      [CHARGE_CLAIM_STALE_MS + MIN, undefined],
      [CHARGE_CLAIM_STALE_MS + MIN, 'chg_1'],
      [19 * HOUR, undefined],
      [CHARGE_CLAIM_AMBIGUOUS_MS, undefined],
      [30 * HOUR, undefined],
    ] as const) {
      expect(free(age, id)).toBe(
        !chargeClaimBlocks(
          { charge_started_at: ago(age), checkout_charge_id: id },
          NOW,
        ),
      );
    }
  });
});
