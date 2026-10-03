import { createHmac } from 'node:crypto';

import { TapWebhookVerifier } from './tap-webhook.verifier';
import { PaymentsConfig } from '../payments.config';
import type { TapCharge, TapRefund } from '../providers/tap/tap.types';

const KEY = 'sk_test_UnitTestKeyNotARealSecret0000';

// `null` = no key configured. (Not `undefined`: that would trigger the default parameter.)
const config = (secret: string | null = KEY) =>
  ({ tapSecretKey: secret ?? undefined }) as unknown as PaymentsConfig;

const charge = (over: Partial<TapCharge> = {}): TapCharge => ({
  id: 'chg_TS012026ABC',
  object: 'charge',
  status: 'CAPTURED',
  amount: 49.99,
  currency: 'SAR',
  reference: {
    gateway: 'GW123',
    payment: 'PAY456',
    transaction: 'ignored-by-signature',
  },
  transaction: { created: '1744036133441' },
  metadata: { udf1: 'not-covered-by-signature' },
  ...over,
});

describe('TapWebhookVerifier', () => {
  const verifier = new TapWebhookVerifier(config());

  describe('canonical string — exactly the documented field order', () => {
    it('charge: x_id … x_amount … x_currency … x_gateway_reference … x_payment_reference … x_status … x_created', () => {
      expect(verifier.canonicalString(charge())).toBe(
        'x_idchg_TS012026ABC' +
          'x_amount49.99' +
          'x_currencySAR' +
          'x_gateway_referenceGW123' +
          'x_payment_referencePAY456' +
          'x_statusCAPTURED' +
          'x_created1744036133441',
      );
    });

    it('rounds the amount to the currency decimals: SAR 2dp, KWD 3dp', () => {
      expect(
        verifier.canonicalString(charge({ amount: 1, currency: 'SAR' })),
      ).toContain('x_amount1.00x_');
      expect(
        verifier.canonicalString(charge({ amount: 1, currency: 'KWD' })),
      ).toContain('x_amount1.000x_');
      expect(
        verifier.canonicalString(charge({ amount: '12.5', currency: 'SAR' })),
      ).toContain('x_amount12.50x_');
    });

    it('uses an empty string for an absent gateway/payment reference', () => {
      const s = verifier.canonicalString(charge({ reference: {} }));
      expect(s).toContain('x_gateway_referencex_payment_referencex_status');
    });

    it('a REFUND takes x_created from the top-level `created`, not transaction.created', () => {
      const refund: TapRefund = {
        id: 're_ABC1',
        object: 'refund',
        status: 'REFUNDED',
        amount: 10,
        currency: 'SAR',
        created: '1744040000000',
        reference: { gateway: 'RGW', payment: 'RPAY' },
      };
      expect(verifier.canonicalString(refund)).toBe(
        'x_idre_ABC1x_amount10.00x_currencySARx_gateway_referenceRGWx_payment_referenceRPAYx_statusREFUNDEDx_created1744040000000',
      );
    });

    it.each([
      ['no payload', undefined],
      [
        'an unsupported object type',
        {
          id: 'inv_1',
          object: 'invoice',
          status: 'PAID',
          amount: 1,
          currency: 'SAR',
        },
      ],
      ['no id', charge({ id: '' })],
      ['no status', charge({ status: undefined })],
      ['no currency', charge({ currency: undefined })],
      ['no amount', charge({ amount: undefined })],
      ['a non-numeric amount', charge({ amount: 'abc' })],
      ['no created timestamp', charge({ transaction: {} })],
    ])('cannot be authenticated with %s → null', (_label, payload) => {
      expect(verifier.canonicalString(payload as any)).toBeNull();
    });
  });

  describe('verify()', () => {
    // Independent vectors: HMAC-SHA256 computed with `openssl dgst -sha256 -hmac`
    // over a hand-written canonical string — not by the code under test.
    it('accepts the independently computed signature for a SAR charge', () => {
      expect(
        verifier.verify(
          charge(),
          '3fa7438a6844c1feffb97ba8c2f65335cf3e98d315be0c9cc9541ecc30dd5551',
        ),
      ).toBe(true);
    });

    it('accepts the independently computed signature for a KWD charge with empty references', () => {
      expect(
        verifier.verify(
          charge({
            id: 'chg_KWD1',
            amount: 1,
            currency: 'KWD',
            reference: {},
            transaction: { created: '1662544753039' },
          }),
          '531dff601fb2c7fe015e5439dd0c290a6cff56457a73320b96911ffd2ea30908',
        ),
      ).toBe(true);
    });

    it('accepts the independently computed signature for a refund', () => {
      expect(
        verifier.verify(
          {
            id: 're_ABC1',
            object: 'refund',
            status: 'REFUNDED',
            amount: 10,
            currency: 'SAR',
            created: '1744040000000',
            reference: { gateway: 'RGW', payment: 'RPAY' },
          },
          '3dea959b27bca6a5e116162ff6e605ae9d1f45f009a08d872b566a169fcfcae0',
        ),
      ).toBe(true);
    });

    const sign = (p: TapCharge) =>
      createHmac('sha256', KEY)
        .update(verifier.canonicalString(p)!)
        .digest('hex');

    it('accepts an uppercase hex header (case-insensitive) and surrounding whitespace', () => {
      expect(
        verifier.verify(charge(), ` ${sign(charge()).toUpperCase()} `),
      ).toBe(true);
    });

    it.each([
      ['status', { status: 'FAILED' }],
      ['amount', { amount: 1 }],
      ['currency', { currency: 'USD' }],
      ['id', { id: 'chg_OTHER' }],
      ['created', { transaction: { created: '1' } }],
      ['gateway reference', { reference: { gateway: 'X', payment: 'PAY456' } }],
    ])(
      'REJECTS a payload whose signed field "%s" was tampered with',
      (_f, patch) => {
        const header = sign(charge());
        expect(
          verifier.verify(charge(patch as Partial<TapCharge>), header),
        ).toBe(false);
      },
    );

    it('does NOT cover metadata/reference.transaction — tampering them still verifies (why the handler re-fetches)', () => {
      const header = sign(charge());
      const tampered = charge({
        metadata: { udf1: '00000000-0000-0000-0000-000000000000' },
        reference: {
          gateway: 'GW123',
          payment: 'PAY456',
          transaction: 'another-payment',
        },
      });
      expect(verifier.verify(tampered, header)).toBe(true);
    });

    it.each([[undefined], [''], ['   '], ['zzzz'], ['3fa7']])(
      'rejects a missing / empty / malformed header (%p)',
      (header) => {
        expect(verifier.verify(charge(), header as any)).toBe(false);
      },
    );

    it('rejects a signature made with a different key', () => {
      const other = createHmac(
        'sha256',
        'sk_test_SomeOtherKey00000000000000000',
      )
        .update(verifier.canonicalString(charge())!)
        .digest('hex');
      expect(verifier.verify(charge(), other)).toBe(false);
    });

    it('FAILS CLOSED when no secret key is configured — even for a correct-looking signature (no dev bypass)', () => {
      const keyless = new TapWebhookVerifier(config(null));
      expect(keyless.verify(charge(), sign(charge()))).toBe(false);
      expect(keyless.verify(charge(), undefined)).toBe(false);
    });

    it('rejects a payload it cannot canonicalise even with a header present', () => {
      expect(
        verifier.verify({ id: 'x', object: 'invoice' } as any, 'abc'),
      ).toBe(false);
    });
  });
});
