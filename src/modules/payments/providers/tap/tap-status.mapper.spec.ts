import {
  mapChargeStatus,
  mapRefundStatus,
  safeFailureReason,
} from './tap-status.mapper';

describe('Tap status mapping', () => {
  describe('mapChargeStatus', () => {
    it('only CAPTURED is paid', () => {
      expect(mapChargeStatus('CAPTURED')).toBe('paid');
      expect(mapChargeStatus('captured')).toBe('paid');
    });

    it.each(['INITIATED', 'IN_PROGRESS', 'PENDING', 'AUTHORIZED'])(
      '%s is still pending',
      (s) => {
        expect(mapChargeStatus(s)).toBe('pending');
      },
    );

    it.each([
      'ABANDONED',
      'CANCELLED',
      'FAILED',
      'DECLINED',
      'RESTRICTED',
      'VOID',
      'TIMEDOUT',
      'TIMED_OUT',
    ])('%s is a definitive failure', (s) => {
      expect(mapChargeStatus(s)).toBe('failed');
    });

    // The critical property: anything we cannot classify must NEVER become
    // `failed`, because a failed payment frees the one-PENDING guard.
    it.each(['UNKNOWN', 'SOMETHING_NEW', '', undefined, null as any])(
      '%p is "unknown", never "failed"',
      (s) => {
        expect(mapChargeStatus(s as any)).toBe('unknown');
      },
    );
  });

  describe('mapRefundStatus', () => {
    it('REFUNDED is the only completed state', () => {
      expect(mapRefundStatus('REFUNDED')).toBe('succeeded');
    });
    it.each(['PENDING', 'IN_PROGRESS', 'ACCEPTED'])(
      '%s is pending — NOT a failure',
      (s) => {
        expect(mapRefundStatus(s)).toBe('pending');
      },
    );
    it.each(['DECLINED', 'FAILED', 'RESTRICTED', 'REJECTED', 'CANCELLED'])(
      '%s is failed',
      (s) => {
        expect(mapRefundStatus(s)).toBe('failed');
      },
    );
    it.each(['TIMED_OUT', 'UNKNOWN', 'WHATEVER', undefined])(
      '%p is unknown',
      (s) => {
        expect(mapRefundStatus(s as any)).toBe('unknown');
      },
    );
  });

  describe("safeFailureReason — user-safe text by response-code family, never Tap's own wording", () => {
    it.each([
      ['301', undefined, 'Payment was not completed'],
      ['302', undefined, 'Payment was cancelled'],
      ['304', undefined, 'Payment session expired'],
      ['801', undefined, 'Payment timed out'],
      ['501', undefined, 'Payment was declined by the card issuer'],
      ['516', undefined, 'Payment was declined by the card issuer'],
      ['701', undefined, 'Payment method is not permitted'],
      ['404', undefined, 'Payment failed'],
      [undefined, 'DECLINED', 'Payment was declined by the card issuer'],
      [undefined, 'ABANDONED', 'Payment was not completed'],
      [undefined, 'TIMEDOUT', 'Payment timed out'],
      [undefined, undefined, 'Payment failed'],
    ])('code %p / status %p → %s', (code, status, expected) => {
      expect(safeFailureReason(code, status)).toBe(expected);
    });
  });
});
