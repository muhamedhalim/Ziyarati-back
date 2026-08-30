import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';

import { EmailWebhookSignatureVerifier } from './email-webhook-signature.verifier';

const SECRET = 'test-resend-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

function makeConfig(secret: string | undefined): ConfigService {
  return { get: () => secret } as unknown as ConfigService;
}

describe('EmailWebhookSignatureVerifier (T136)', () => {
  const body = JSON.stringify({
    type: 'email.bounced',
    data: { email_id: 'm1' },
  });

  it('accepts a correctly-signed payload', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(SECRET));
    expect(verifier.verify(sign(body), Buffer.from(body))).toBe(true);
  });

  it('rejects an invalid signature (wrong secret)', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(SECRET));
    expect(verifier.verify(sign(body, 'wrong-secret'), Buffer.from(body))).toBe(
      false,
    );
  });

  it('rejects a tampered body (signature computed over a different payload)', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(SECRET));
    const tampered = JSON.stringify({
      type: 'email.bounced',
      data: { email_id: 'm2' },
    });
    expect(verifier.verify(sign(body), Buffer.from(tampered))).toBe(false);
  });

  it('fails CLOSED when RESEND_WEBHOOK_SECRET is not configured', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(undefined));
    expect(verifier.verify(sign(body), Buffer.from(body))).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(SECRET));
    expect(verifier.verify(undefined, Buffer.from(body))).toBe(false);
  });

  it('rejects a missing raw body', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(SECRET));
    expect(verifier.verify(sign(body), undefined)).toBe(false);
  });

  it('rejects a malformed signature header (wrong scheme)', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(SECRET));
    expect(verifier.verify('md5=deadbeef', Buffer.from(body))).toBe(false);
  });

  // The same signed payload verified a second time behaves IDENTICALLY — the
  // verifier itself has no replay memory (replay protection is the
  // suppression write's own idempotency, per email-webhook.controller.spec.ts).
  it('verifying the same payload twice is deterministic (no hidden replay state here)', () => {
    const verifier = new EmailWebhookSignatureVerifier(makeConfig(SECRET));
    const sig = sign(body);
    expect(verifier.verify(sig, Buffer.from(body))).toBe(true);
    expect(verifier.verify(sig, Buffer.from(body))).toBe(true);
  });
});
