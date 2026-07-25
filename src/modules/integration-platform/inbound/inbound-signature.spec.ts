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
