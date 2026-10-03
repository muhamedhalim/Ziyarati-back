import { extractSavedPaymentMethod } from './tap-saved-method';
import type { TapCharge } from './tap.types';

const base = (over: Partial<TapCharge> = {}): TapCharge => ({
  id: 'chg_1',
  customer: { id: 'cus_1' },
  card: { id: 'card_1', brand: 'VISA', scheme: 'VISA', last_four: '1019' },
  payment_agreement: { id: 'payment_agreement_1' },
  ...over,
});

describe('extractSavedPaymentMethod', () => {
  it('reads the three ids and the display facts', () => {
    expect(extractSavedPaymentMethod(base())).toEqual({
      provider: 'tap',
      customerId: 'cus_1',
      cardId: 'card_1',
      agreementId: 'payment_agreement_1',
      brand: 'VISA',
      scheme: 'VISA',
      lastFour: '1019',
      recurringCapable: true,
    });
  });

  it('accepts the card id from the agreement contract when the card object does not carry it', () => {
    const m = extractSavedPaymentMethod(
      base({
        card: { last_four: '0007', scheme: 'MADA' },
        payment_agreement: {
          id: 'payment_agreement_1',
          contract: { id: 'card_from_contract', type: 'UNSCHEDULED' },
        },
      }),
    );
    expect(m?.cardId).toBe('card_from_contract');
    expect(m?.scheme).toBe('MADA');
  });

  it.each([
    ['customer id', { customer: undefined }],
    ['payment agreement id', { payment_agreement: undefined }],
    ['card id', { card: { scheme: 'VISA' }, payment_agreement: { id: 'a' } }],
  ])(
    'returns nothing when the %s is missing — a half-record would only look usable',
    (_l, over) => {
      expect(
        extractSavedPaymentMethod(base(over as Partial<TapCharge>)),
      ).toBeUndefined();
    },
  );

  it.each(['KNET', 'knet', 'BENEFIT', 'STC_PAY'])(
    'a %s card cannot be charged without the payer present',
    (scheme) => {
      const m = extractSavedPaymentMethod(
        base({ card: { id: 'card_1', scheme } }),
      );
      expect(m?.recurringCapable).toBe(false);
    },
  );

  it('mada is treated as recurring-capable until the sandbox says otherwise', () => {
    const m = extractSavedPaymentMethod(
      base({ card: { id: 'card_1', scheme: 'MADA' } }),
    );
    expect(m?.recurringCapable).toBe(true);
  });

  it('falls back to the payment method when the card carries no scheme', () => {
    const m = extractSavedPaymentMethod(
      base({ card: { id: 'card_1' }, source: { payment_method: 'KNET' } }),
    );
    expect(m?.scheme).toBe('KNET');
    expect(m?.recurringCapable).toBe(false);
  });

  it('keeps only the last four digits, however many Tap sent', () => {
    const m = extractSavedPaymentMethod(
      base({ card: { id: 'card_1', last_four: '4508750015741019' } }),
    );
    expect(m?.lastFour).toBe('1019');
  });

  it('never carries a card number, expiry or any key beyond the documented ids and display facts', () => {
    const m = extractSavedPaymentMethod(
      base({
        card: {
          id: 'card_1',
          first_six: '450875',
          first_eight: '45087500',
          exp_month: 1,
          exp_year: 39,
        } as never,
      }),
    );
    expect(Object.keys(m!).sort()).toEqual(
      [
        'agreementId',
        'brand',
        'cardId',
        'customerId',
        'lastFour',
        'provider',
        'recurringCapable',
        'scheme',
      ].sort(),
    );
  });
});
