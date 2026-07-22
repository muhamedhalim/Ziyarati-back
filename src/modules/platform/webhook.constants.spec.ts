import {
  WEBHOOK_EVENTS,
  normalizeWebhookEvents,
  generateWebhookSecret,
  webhookSecretPrefix,
  computeWebhookSignature,
  verifyWebhookSignature,
  WEBHOOK_SECRET_PREFIX,
} from './webhook.constants';

describe('webhook.constants', () => {
  describe('normalizeWebhookEvents', () => {
    it('keeps only recognised event names', () => {
      expect(normalizeWebhookEvents(['appointment.created', 'bogus.event', 'payment.succeeded'])).toEqual([
        'appointment.created',
        'payment.succeeded',
      ]);
    });

    it('de-duplicates', () => {
      expect(normalizeWebhookEvents(['appointment.created', 'appointment.created'])).toEqual([
        'appointment.created',
      ]);
    });

    it('is legacy/junk-safe for non-array input', () => {
      expect(normalizeWebhookEvents(null)).toEqual([]);
      expect(normalizeWebhookEvents(undefined)).toEqual([]);
      expect(normalizeWebhookEvents('appointment.created')).toEqual([]);
      expect(normalizeWebhookEvents([1, {}, 'appointment.created'])).toEqual(['appointment.created']);
    });
  });

  describe('generateWebhookSecret / webhookSecretPrefix', () => {
    it('generates a prefixed, sufficiently long secret', () => {
      const secret = generateWebhookSecret();
      expect(secret.startsWith(`${WEBHOOK_SECRET_PREFIX}_`)).toBe(true);
      expect(secret.length).toBeGreaterThan(30);
    });

    it('generates different secrets each call', () => {
      expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
    });

    it('prefix is a strict prefix of the plaintext', () => {
      const secret = generateWebhookSecret();
      expect(secret.startsWith(webhookSecretPrefix(secret))).toBe(true);
    });
  });

  describe('computeWebhookSignature / verifyWebhookSignature', () => {
    const secret = 'whsec_test-secret';
    const body = JSON.stringify({ hello: 'world' });
    const ts = 1_700_000_000;

    it('produces a sha256= prefixed hex digest', () => {
      const sig = computeWebhookSignature(secret, ts, body);
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it('is deterministic for the same inputs', () => {
      expect(computeWebhookSignature(secret, ts, body)).toBe(computeWebhookSignature(secret, ts, body));
    });

    it('changes if the timestamp changes (replay-protection input)', () => {
      expect(computeWebhookSignature(secret, ts, body)).not.toBe(computeWebhookSignature(secret, ts + 1, body));
    });

    it('changes if the body changes', () => {
      expect(computeWebhookSignature(secret, ts, body)).not.toBe(
        computeWebhookSignature(secret, ts, body + 'x'),
      );
    });

    it('changes if the secret changes', () => {
      expect(computeWebhookSignature(secret, ts, body)).not.toBe(
        computeWebhookSignature('whsec_other', ts, body),
      );
    });

    it('verifies a correctly-computed signature', () => {
      const sig = computeWebhookSignature(secret, ts, body);
      expect(verifyWebhookSignature(secret, ts, body, sig)).toBe(true);
    });

    it('rejects a tampered signature', () => {
      const sig = computeWebhookSignature(secret, ts, body);
      const tampered = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
      expect(verifyWebhookSignature(secret, ts, body, tampered)).toBe(false);
    });

    it('rejects a signature computed with a different timestamp (replay)', () => {
      const sig = computeWebhookSignature(secret, ts, body);
      expect(verifyWebhookSignature(secret, ts + 300, body, sig)).toBe(false);
    });

    it('rejects a signature of a different length without throwing', () => {
      expect(verifyWebhookSignature(secret, ts, body, 'sha256=short')).toBe(false);
    });
  });

  describe('WEBHOOK_EVENTS allowlist', () => {
    it('is non-empty and every entry is a dot-namespaced string', () => {
      expect(WEBHOOK_EVENTS.length).toBeGreaterThan(0);
      for (const e of WEBHOOK_EVENTS) {
        expect(e).toMatch(/^[a-z]+\.[a-z_]+$/);
      }
    });
  });
});
