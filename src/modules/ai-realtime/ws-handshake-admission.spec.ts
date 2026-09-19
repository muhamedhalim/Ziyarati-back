import {
  WS_REJECT_MESSAGE,
  WsRejectionLog,
  evaluateWsHandshake,
  sanitizeForLog,
} from './ws-handshake-admission';

/**
 * The CSWSH admission policy in isolation — every row of its decision table.
 * The wire-level proof that it is actually installed on the Socket.IO server,
 * for both transports, lives in `test/security/ws-cswsh-handshake.spec.ts`.
 */
describe('evaluateWsHandshake', () => {
  const APP = 'https://app.example.com';
  const allowed = new Set([APP, 'https://book.example.com']);
  const verdict = (headers: Record<string, string | string[] | undefined>) =>
    evaluateWsHandshake(headers, allowed);

  describe('Origin — the primary defence', () => {
    it('admits an allow-listed origin', () => {
      expect(verdict({ origin: APP })).toEqual({ allowed: true });
      expect(verdict({ origin: 'https://book.example.com' })).toEqual({
        allowed: true,
      });
    });

    it('refuses a foreign origin, even when it carries the victim cookie', () => {
      expect(
        verdict({
          origin: 'https://attacker.example',
          cookie: 'access_token=x; guest_token=y',
        }),
      ).toEqual({ allowed: false, reason: 'origin_not_allowed' });
    });

    it('refuses the opaque "null" origin (sandboxed iframe, data:, file:)', () => {
      expect(verdict({ origin: 'null' })).toEqual({
        allowed: false,
        reason: 'origin_null',
      });
    });

    it('refuses "null" even if a development file put it in the allow-list', () => {
      expect(
        evaluateWsHandshake({ origin: 'null' }, new Set(['null', APP])),
      ).toEqual({ allowed: false, reason: 'origin_null' });
    });

    it('refuses an empty Origin header — present but not an origin', () => {
      expect(verdict({ origin: '' })).toEqual({
        allowed: false,
        reason: 'origin_not_allowed',
      });
    });

    /**
     * The comparison is exact string equality. Every entry below is the kind of
     * thing a substring, `startsWith`, `endsWith` or loose-regex check waves
     * through.
     */
    it.each([
      ['a same-site sibling subdomain', 'https://evil.example.com'],
      ['a suffix attack', 'https://app.example.com.attacker.example'],
      ['a prefix attack', 'https://evil-app.example.com'],
      [
        'the allowed origin embedded as userinfo',
        'https://app.example.com@attacker.example',
      ],
      ['a different scheme', 'http://app.example.com'],
      ['a different port', 'https://app.example.com:8443'],
      ['a different letter case', 'HTTPS://APP.EXAMPLE.COM'],
      ['a trailing slash (not an origin)', 'https://app.example.com/'],
      ['a path (not an origin)', 'https://app.example.com/path'],
      ['a wildcard', '*'],
      [
        'a duplicate header joined by Node',
        'https://attacker.example, https://app.example.com',
      ],
    ])('refuses %s', (_label, origin) => {
      expect(verdict({ origin })).toEqual({
        allowed: false,
        reason: 'origin_not_allowed',
      });
    });

    it('refuses when Node hands over a duplicated Origin as an array', () => {
      expect(verdict({ origin: [APP, APP] })).toEqual({
        allowed: false,
        reason: 'origin_not_allowed',
      });
    });
  });

  describe('a missing Origin', () => {
    it('is refused when a Cookie is present — cookies are the ambient credential CSWSH abuses', () => {
      expect(verdict({ cookie: 'access_token=x' })).toEqual({
        allowed: false,
        reason: 'origin_missing_with_cookie',
      });
    });

    it('is admitted with no Cookie: a native/test client using an explicit auth.token has nothing ambient to hijack', () => {
      expect(verdict({})).toEqual({ allowed: true });
    });

    it('is admitted with an Authorization header and no Cookie (explicit credential)', () => {
      expect(verdict({ authorization: 'Bearer abc' })).toEqual({
        allowed: true,
      });
    });

    it('treats an empty Cookie header as no cookie', () => {
      expect(verdict({ cookie: '' })).toEqual({ allowed: true });
    });

    it('is still refused when a Cookie is present alongside an Authorization header', () => {
      expect(
        verdict({ authorization: 'Bearer abc', cookie: 'access_token=x' }),
      ).toEqual({ allowed: false, reason: 'origin_missing_with_cookie' });
    });
  });

  describe('Fetch Metadata — defence in depth, never a substitute for Origin', () => {
    it('refuses Sec-Fetch-Site: cross-site even from an allow-listed origin', () => {
      expect(verdict({ origin: APP, 'sec-fetch-site': 'cross-site' })).toEqual({
        allowed: false,
        reason: 'fetch_metadata_cross_site',
      });
    });

    it('normalises the header value (case, whitespace)', () => {
      expect(
        verdict({ origin: APP, 'sec-fetch-site': ' Cross-Site ' }),
      ).toEqual({ allowed: false, reason: 'fetch_metadata_cross_site' });
    });

    it('refuses cross-site on a request with no Origin and no Cookie too', () => {
      expect(verdict({ 'sec-fetch-site': 'cross-site' })).toEqual({
        allowed: false,
        reason: 'fetch_metadata_cross_site',
      });
    });

    it.each(['same-origin', 'same-site', 'none'])(
      'admits Sec-Fetch-Site: %s',
      (site) => {
        expect(verdict({ origin: APP, 'sec-fetch-site': site })).toEqual({
          allowed: true,
        });
      },
    );

    it('never treats an ABSENT header as hostile — older browsers and every non-browser client omit it', () => {
      expect(verdict({ origin: APP })).toEqual({ allowed: true });
    });

    it('ignores an unknown value rather than refusing on it', () => {
      expect(
        verdict({ origin: APP, 'sec-fetch-site': 'from-the-future' }),
      ).toEqual({ allowed: true });
    });

    it('does NOT rescue a foreign origin: Sec-Fetch-Site: same-origin cannot override the Origin check', () => {
      expect(
        verdict({
          origin: 'https://attacker.example',
          'sec-fetch-site': 'same-origin',
        }),
      ).toEqual({ allowed: false, reason: 'origin_not_allowed' });
    });

    it('reports the Origin failure, not the Fetch Metadata one, when both apply', () => {
      expect(
        verdict({
          origin: 'https://attacker.example',
          'sec-fetch-site': 'cross-site',
        }),
      ).toEqual({ allowed: false, reason: 'origin_not_allowed' });
    });
  });

  it('never reflects request data in what the peer is told', () => {
    for (const message of Object.values(WS_REJECT_MESSAGE)) {
      expect(message).not.toMatch(/attacker|http|cookie|token/i);
    }
  });
});

describe('sanitizeForLog', () => {
  it('marks an absent header explicitly', () => {
    expect(sanitizeForLog(undefined)).toBe('(absent)');
  });

  it('replaces anything that is not printable ASCII', () => {
    expect(sanitizeForLog('https://a.example\r\nX-Injected: 1')).toBe(
      'https://a.example??X-Injected: 1',
    );
    expect(sanitizeForLog('https://ملف.example')).not.toMatch(/[^\x20-\x7e]/);
  });

  it('bounds the length so a hostile header cannot flood a log line', () => {
    const out = sanitizeForLog('a'.repeat(5_000));
    expect(out.length).toBeLessThan(200);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('WsRejectionLog', () => {
  it('logs the first refusal of each reason immediately, suppresses the flood, and reports the count later', () => {
    let now = 1_000;
    const log = new WsRejectionLog(60_000, () => now);

    expect(log.shouldLog('origin_not_allowed')).toEqual({ suppressed: 0 });
    for (let i = 0; i < 500; i += 1) {
      now += 10;
      expect(log.shouldLog('origin_not_allowed')).toBeNull();
    }
    now += 60_000;
    expect(log.shouldLog('origin_not_allowed')).toEqual({ suppressed: 500 });
    expect(log.shouldLog('origin_not_allowed')).toBeNull();
  });

  it('throttles each reason independently — a flood of one must not hide the first of another', () => {
    const log = new WsRejectionLog(60_000, () => 5_000);
    expect(log.shouldLog('origin_not_allowed')).toEqual({ suppressed: 0 });
    expect(log.shouldLog('origin_null')).toEqual({ suppressed: 0 });
    expect(log.shouldLog('origin_not_allowed')).toBeNull();
    expect(log.shouldLog('origin_null')).toBeNull();
  });
});
