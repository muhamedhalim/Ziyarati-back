import {
  subscriptionChargeRouting,
  subscriptionMisroutedLogLine,
} from './tap-routing';

describe('subscriptionChargeRouting', () => {
  it('ok only when Tap echoes exactly the expected merchant', () => {
    expect(
      subscriptionChargeRouting({ merchant: { id: '68076090' } }, '68076090'),
    ).toBe('ok');
    expect(
      subscriptionChargeRouting({ merchant: { id: ' 68076090 ' } }, '68076090'),
    ).toBe('ok');
  });

  it('misrouted when Tap names a different merchant', () => {
    expect(
      subscriptionChargeRouting({ merchant: { id: '111' } }, '68076090'),
    ).toBe('misrouted');
  });

  it.each([
    ['no merchant echo', { merchant: undefined }, '68076090'],
    ['an empty merchant id', { merchant: { id: '' } }, '68076090'],
    ['no charge at all', undefined, '68076090'],
    [
      'no expected merchant configured',
      { merchant: { id: '68076090' } },
      undefined,
    ],
    ['a blank expected merchant', { merchant: { id: '68076090' } }, '  '],
  ])('unverified (fail closed) for %s', (_l, charge, expected) => {
    expect(subscriptionChargeRouting(charge as never, expected)).toBe(
      'unverified',
    );
  });
});

describe('subscriptionMisroutedLogLine', () => {
  it('starts with ALERT: so the P-01 payments alarm (pattern "ALERT:") fires', () => {
    expect(subscriptionMisroutedLogLine('chg_1', 'misrouted')).toMatch(
      /^ALERT: subscription charge chg_1 was NOT routed to the ZiyaraTech merchant/,
    );
  });

  it('keeps an attacker-controlled charge id to a short plain token', () => {
    const line = subscriptionMisroutedLogLine(
      'chg_\n<script>' + 'x'.repeat(200),
      'unverified',
    );
    expect(line).not.toContain('\n');
    expect(line).not.toContain('<');
    expect(line.length).toBeLessThan(200);
  });
});
