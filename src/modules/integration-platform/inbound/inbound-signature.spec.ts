import { createHmac } from 'node:crypto';

import {
  computeInboundSignature,
  header,
  readInboundHeaders,
  signingPayload,
  verifyInboundSignature,
  verifyTimestamp,
} from './inbound-signature';
import {
  INBOUND_HEADER,
  WEBHOOK_SIGNATURE_SCHEME,
} from '../integration-platform.constants';

const SECRET = 'a'.repeat(64);
const TS = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED;
const BODY = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_BODY;

describe('inbound webhook signature verification', () => {
  const raw = '{"externalId":"EXT-1","data":{"full_name":"Sara"}}';
  const ts = String(Math.floor(Date.now() / 1000));

  it('accepts a correctly signed timestamped delivery', () => {
    const sig = computeInboundSignature(TS, SECRET, ts, raw);
    expect(verifyInboundSignature(TS, SECRET, ts, raw, sig)).toBe(true);
  });

  it('accepts the digest with or without the sha256= prefix', () => {
    const sig = computeInboundSignature(TS, SECRET, ts, raw);
    expect(verifyInboundSignature(TS, SECRET, ts, raw, sig.slice('sha256='.length))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const sig = computeInboundSignature(TS, SECRET, ts, raw);
    expect(verifyInboundSignature(TS, 'b'.repeat(64), ts, raw, sig)).toBe(false);
  });

  it('rejects a tampered body — even one byte', () => {
    const sig = computeInboundSignature(TS, SECRET, ts, raw);
    const tampered = raw.replace('Sara', 'Mara');
    expect(verifyInboundSignature(TS, SECRET, ts, tampered, sig)).toBe(false);
  });

  it('binds the TIMESTAMP into the MAC, so editing it invalidates the signature', () => {
    const sig = computeInboundSignature(TS, SECRET, ts, raw);
    const later = String(Number(ts) + 5_000);
    expect(verifyInboundSignature(TS, SECRET, later, raw, sig)).toBe(false);
    // This is what makes the replay window enforceable rather than advisory.
    expect(signingPayload(TS, ts, raw)).toBe(`${ts}.${raw}`);
  });

  it('rejects an empty or missing signature', () => {
    expect(verifyInboundSignature(TS, SECRET, ts, raw, '')).toBe(false);
    expect(verifyInboundSignature(TS, SECRET, ts, raw, undefined as never)).toBe(false);
  });

  it('rejects when no secret is configured (never accepts unverified)', () => {
    const sig = computeInboundSignature(TS, SECRET, ts, raw);
    expect(verifyInboundSignature(TS, '', ts, raw, sig)).toBe(false);
  });

  it('body-only scheme signs the raw body alone', () => {
    const sig = computeInboundSignature(BODY, SECRET, undefined, raw);
    expect(verifyInboundSignature(BODY, SECRET, 'anything', raw, sig)).toBe(true);
    expect(signingPayload(BODY, ts, raw)).toBe(raw);
  });
});

describe('v2 signature — event id and type are bound into the MAC (SEC-01)', () => {
  const V2 = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED_V2;
  const raw = '{"externalId":"EXT-1","data":{"full_name":"Sara"}}';
  const ts = String(Math.floor(Date.now() / 1000));
  const meta = { eventId: 'evt-1', eventType: 'customer.upserted' };

  it('accepts a correctly signed delivery', () => {
    const sig = computeInboundSignature(V2, SECRET, ts, raw, meta);
    expect(verifyInboundSignature(V2, SECRET, ts, raw, sig, meta)).toBe(true);
  });

  it('signs "ts \\n eventId \\n eventType \\n body" — newline-separated so the parts cannot be re-split', () => {
    expect(signingPayload(V2, ts, raw, meta)).toBe(`${ts}\nevt-1\ncustomer.upserted\n${raw}`);
  });

  it('REJECTS a replay with a fresh event id (the SEC-01 attack: same body, new X-Ziyarati-Event-Id)', () => {
    const sig = computeInboundSignature(V2, SECRET, ts, raw, meta);
    expect(verifyInboundSignature(V2, SECRET, ts, raw, sig, { ...meta, eventId: 'evt-2' })).toBe(false);
  });

  it('REJECTS a swapped event type (appointment.created ↔ appointment.cancelled)', () => {
    const sig = computeInboundSignature(V2, SECRET, ts, raw, {
      eventId: 'evt-1',
      eventType: 'appointment.created',
    });
    expect(
      verifyInboundSignature(V2, SECRET, ts, raw, sig, {
        eventId: 'evt-1',
        eventType: 'appointment.cancelled',
      }),
    ).toBe(false);
  });

  it('cannot be re-split: shifting a boundary between timestamp and event id changes the MAC', () => {
    // With a "." separator these two would sign identically.
    const a = computeInboundSignature(V2, SECRET, '1800000000', raw, { eventId: '5.x', eventType: 'a.b' });
    const b = computeInboundSignature(V2, SECRET, '1800000000.5', raw, { eventId: 'x', eventType: 'a.b' });
    expect(a).not.toBe(b);
  });

  it('refuses to verify when either header is missing, even against a MAC over blanks', () => {
    const blank = createHmac('sha256', SECRET).update(`${ts}\n\n\n${raw}`).digest('hex');
    expect(verifyInboundSignature(V2, SECRET, ts, raw, `sha256=${blank}`, {})).toBe(false);
    expect(verifyInboundSignature(V2, SECRET, ts, raw, `sha256=${blank}`, { eventId: 'evt-1' })).toBe(false);
    expect(signingPayload(V2, ts, raw, { eventType: 'customer.upserted' })).toBeNull();
    expect(() => computeInboundSignature(V2, SECRET, ts, raw, {})).toThrow();
  });

  it('a v1 signature does not verify under v2 and vice-versa (no downgrade by relabelling)', () => {
    const v1 = computeInboundSignature(TS, SECRET, ts, raw);
    expect(verifyInboundSignature(V2, SECRET, ts, raw, v1, meta)).toBe(false);
    const v2 = computeInboundSignature(V2, SECRET, ts, raw, meta);
    expect(verifyInboundSignature(TS, SECRET, ts, raw, v2)).toBe(false);
  });

  it('still enforces the replay window (v2 is a timestamped scheme)', () => {
    const now = 1_800_000_000_000;
    expect(verifyTimestamp(V2, String(Math.floor(now / 1000) - 3600), 300, now)).toBe('stale');
    expect(verifyTimestamp(V2, String(Math.floor(now / 1000) + 3600), 300, now)).toBe('future');
    expect(verifyTimestamp(V2, undefined, 300, now)).toBe('missing');
  });

  it('documents the legacy gap: under v1 the event headers are NOT part of the MAC', () => {
    const sig = computeInboundSignature(TS, SECRET, ts, raw);
    // Same signature verifies no matter what the (unsigned) headers say — which is
    // exactly why v1 is legacy and v2 is the default for new endpoints.
    expect(verifyInboundSignature(TS, SECRET, ts, raw, sig, { eventId: 'anything', eventType: 'x' })).toBe(true);
  });
});

describe('replay-window (timestamp) validation', () => {
  const now = 1_800_000_000_000; // fixed clock
  const nowSec = Math.floor(now / 1000);

  it('accepts a timestamp inside the tolerance', () => {
    expect(verifyTimestamp(TS, String(nowSec - 60), 300, now)).toBe('ok');
  });

  it('rejects a STALE timestamp — a captured request replayed later', () => {
    expect(verifyTimestamp(TS, String(nowSec - 3600), 300, now)).toBe('stale');
  });

  it('rejects a FUTURE timestamp — a signature minted to stay valid forever', () => {
    expect(verifyTimestamp(TS, String(nowSec + 3600), 300, now)).toBe('future');
  });

  it('rejects a missing or malformed timestamp', () => {
    expect(verifyTimestamp(TS, undefined, 300, now)).toBe('missing');
    expect(verifyTimestamp(TS, 'not-a-number', 300, now)).toBe('malformed');
    expect(verifyTimestamp(TS, '0', 300, now)).toBe('malformed');
  });

  it('skips the window for the body-only scheme, which cannot enforce it', () => {
    // The timestamp is not in the MAC there, so an attacker would simply edit
    // the header — replay protection rests on the persisted event id instead.
    expect(verifyTimestamp(BODY, String(nowSec - 999_999), 300, now)).toBe('ok');
  });
});

describe('header reading', () => {
  it('is case-insensitive', () => {
    expect(header({ 'X-Ziyarati-Signature': 'v' }, INBOUND_HEADER.SIGNATURE)).toBe('v');
    expect(header({ 'x-ziyarati-signature': 'v' }, INBOUND_HEADER.SIGNATURE)).toBe('v');
  });

  it('reads the full inbound header set', () => {
    const h = readInboundHeaders({
      [INBOUND_HEADER.SIGNATURE]: 'sha256=abc',
      [INBOUND_HEADER.TIMESTAMP]: '123',
      [INBOUND_HEADER.EVENT_ID]: 'evt-1',
      [INBOUND_HEADER.EVENT_TYPE]: 'customer.upserted',
    });
    expect(h).toEqual({
      signature: 'sha256=abc',
      timestamp: '123',
      eventId: 'evt-1',
      eventType: 'customer.upserted',
    });
  });
});
