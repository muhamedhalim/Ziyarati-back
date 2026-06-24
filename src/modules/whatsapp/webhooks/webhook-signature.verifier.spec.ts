import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

import { WebhookSignatureVerifier } from './webhook-signature.verifier';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

const APP_SECRET = 'meta-app-secret';

const sign = (body: Buffer, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('WebhookSignatureVerifier', () => {
  const build = (overrides: Record<string, unknown> = { WHATSAPP_APP_SECRET: APP_SECRET }) =>
    new WebhookSignatureVerifier(createMockConfigService(overrides) as unknown as ConfigService);

  describe('verify (X-Hub-Signature-256 over raw bytes)', () => {
    const body = Buffer.from(JSON.stringify({ entry: [{ id: '1' }] }));

    it('accepts a correct HMAC-SHA256 signature', () => {
      expect(build().verify(sign(body), body)).toBe(true);
    });

    it('rejects a tampered body (signature mismatch)', () => {
      expect(build().verify(sign(body), Buffer.from('tampered'))).toBe(false);
    });

    it('FAILS CLOSED when the app secret is not configured', () => {
      expect(build({ WHATSAPP_APP_SECRET: '' }).verify(sign(body), body)).toBe(false);
    });

    it('rejects a missing signature header', () => {
      expect(build().verify(undefined, body)).toBe(false);
    });

    it('rejects an empty raw body', () => {
      expect(build().verify(sign(body), Buffer.alloc(0))).toBe(false);
    });

    it('rejects a malformed signature header (wrong scheme)', () => {
      expect(build().verify(`sha1=${'a'.repeat(40)}`, body)).toBe(false);
    });
  });

  describe('resolveChallenge (GET verification handshake)', () => {
    it('echoes the challenge when mode=subscribe and the token matches', () => {
      expect(build().resolveChallenge('subscribe', 'verify-tok', 'CHALLENGE', 'verify-tok')).toBe(
        'CHALLENGE',
      );
    });

    it('returns null on a token mismatch', () => {
      expect(build().resolveChallenge('subscribe', 'wrong', 'CHALLENGE', 'verify-tok')).toBeNull();
    });

    it('returns null when the expected token is not configured', () => {
      expect(build().resolveChallenge('subscribe', 'x', 'CHALLENGE', undefined)).toBeNull();
    });

    it('returns null when mode is not subscribe', () => {
      expect(build().resolveChallenge('unsubscribe', 'verify-tok', 'C', 'verify-tok')).toBeNull();
    });
  });
});
