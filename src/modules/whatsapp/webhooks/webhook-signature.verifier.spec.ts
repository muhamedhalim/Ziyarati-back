import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

import { WebhookSignatureVerifier } from './webhook-signature.verifier';
import { MetaConfig } from '../meta/meta.config';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

const APP_SECRET = 'meta-app-secret';

const sign = (body: Buffer, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('WebhookSignatureVerifier', () => {
  // Secrets now resolve through MetaConfig (canonical META_* names, with the
  // legacy WHATSAPP_* names still honoured) rather than raw ConfigService.
  const build = (overrides: Record<string, unknown> = { META_APP_SECRET: APP_SECRET }) =>
    new WebhookSignatureVerifier(
      new MetaConfig(createMockConfigService(overrides) as unknown as ConfigService),
    );

  describe('verify (X-Hub-Signature-256 over raw bytes)', () => {
    const body = Buffer.from(JSON.stringify({ entry: [{ id: '1' }] }));

    it('accepts a correct HMAC-SHA256 signature', () => {
      expect(build().verify(sign(body), body)).toBe(true);
    });

    it('rejects a tampered body (signature mismatch)', () => {
      expect(build().verify(sign(body), Buffer.from('tampered'))).toBe(false);
    });

    it('FAILS CLOSED when the app secret is not configured', () => {
      expect(build({ META_APP_SECRET: '' }).verify(sign(body), body)).toBe(false);
    });

    it('still honours the legacy WHATSAPP_APP_SECRET name during migration', () => {
      // Deploys that have not yet renamed their env must keep verifying.
      expect(build({ WHATSAPP_APP_SECRET: APP_SECRET }).verify(sign(body), body)).toBe(true);
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
