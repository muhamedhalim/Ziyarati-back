import { assertSafeWebhookUrl, resolveSafeWebhookTarget, SsrfBlockedError } from './webhook-url-guard';
import { AppError } from '../../common/errors';

jest.mock('node:dns', () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dnsMock = (jest.requireMock('node:dns') as { promises: { resolve4: jest.Mock; resolve6: jest.Mock } }).promises;

describe('assertSafeWebhookUrl', () => {
  describe('allows', () => {
    it('a public https URL', () => {
      expect(() => assertSafeWebhookUrl('https://example.com/webhooks/ziyarati')).not.toThrow();
    });

    it('a public http URL (plain http is allowed for outbound webhooks)', () => {
      expect(() => assertSafeWebhookUrl('http://api.myclinic.example/hooks')).not.toThrow();
    });

    it('a public URL with a standard high port', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:8443/hook')).not.toThrow();
    });
  });

  describe('rejects invalid input', () => {
    it('a malformed URL', () => {
      expect(() => assertSafeWebhookUrl('not a url')).toThrow(AppError);
    });

    it('an unsupported scheme (ftp)', () => {
      expect(() => assertSafeWebhookUrl('ftp://example.com/file')).toThrow(AppError);
    });

    it('a data: URL', () => {
      expect(() => assertSafeWebhookUrl('data:text/plain,hello')).toThrow(AppError);
    });

    it('credentials embedded in the URL', () => {
      expect(() => assertSafeWebhookUrl('https://user:pass@example.com/hook')).toThrow(AppError);
    });
  });

  describe('rejects SSRF targets', () => {
    it('localhost', () => {
      expect(() => assertSafeWebhookUrl('http://localhost/hook')).toThrow(AppError);
      expect(() => assertSafeWebhookUrl('http://sub.localhost/hook')).toThrow(AppError);
    });

    it('loopback IPv4 (127.0.0.1)', () => {
      expect(() => assertSafeWebhookUrl('http://127.0.0.1/hook')).toThrow(AppError);
    });

    it('IPv6 loopback (::1)', () => {
      expect(() => assertSafeWebhookUrl('http://[::1]/hook')).toThrow(AppError);
    });

    it('private 10.0.0.0/8', () => {
      expect(() => assertSafeWebhookUrl('http://10.1.2.3/hook')).toThrow(AppError);
    });

    it('private 192.168.0.0/16', () => {
      expect(() => assertSafeWebhookUrl('http://192.168.1.1/hook')).toThrow(AppError);
    });

    it('private 172.16.0.0/12', () => {
      expect(() => assertSafeWebhookUrl('http://172.20.1.1/hook')).toThrow(AppError);
    });

    it('cloud metadata IP (169.254.169.254)', () => {
      expect(() => assertSafeWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow(AppError);
    });

    it('CGNAT range (100.64.0.0/10)', () => {
      expect(() => assertSafeWebhookUrl('http://100.64.0.1/hook')).toThrow(AppError);
    });

    it('.internal / .local hostnames', () => {
      expect(() => assertSafeWebhookUrl('http://service.internal/hook')).toThrow(AppError);
      expect(() => assertSafeWebhookUrl('http://printer.local/hook')).toThrow(AppError);
    });

    it('IPv6 link-local (fe80::/10)', () => {
      expect(() => assertSafeWebhookUrl('http://[fe80::1]/hook')).toThrow(AppError);
    });

    it('IPv6 unique-local (fc00::/7)', () => {
      expect(() => assertSafeWebhookUrl('http://[fd12:3456:789a::1]/hook')).toThrow(AppError);
    });

    it('malformed IPv4 octets (defense-in-depth, block rather than guess)', () => {
      expect(() => assertSafeWebhookUrl('http://999.1.1.1/hook')).toThrow(AppError);
    });

    it('multicast (224.0.0.0/4) and reserved (240.0.0.0/4) IPv4', () => {
      expect(() => assertSafeWebhookUrl('http://224.0.0.1/hook')).toThrow(AppError);
      expect(() => assertSafeWebhookUrl('http://240.0.0.1/hook')).toThrow(AppError);
      expect(() => assertSafeWebhookUrl('http://255.255.255.255/hook')).toThrow(AppError);
    });

    it('IPv6 documentation prefix (2001:db8::/32)', () => {
      expect(() => assertSafeWebhookUrl('http://[2001:db8::1]/hook')).toThrow(AppError);
    });

    it('IPv6 multicast (ff00::/8)', () => {
      expect(() => assertSafeWebhookUrl('http://[ff02::1]/hook')).toThrow(AppError);
    });

    describe('encoded/alternative IPv4 formats (WHATWG URL normalizes these to dotted-decimal before we see them)', () => {
      it('decimal notation for 127.0.0.1', () => {
        expect(() => assertSafeWebhookUrl('http://2130706433/hook')).toThrow(AppError);
      });

      it('hex notation for 127.0.0.1', () => {
        expect(() => assertSafeWebhookUrl('http://0x7f000001/hook')).toThrow(AppError);
      });

      it('octal notation for 127.0.0.1', () => {
        expect(() => assertSafeWebhookUrl('http://017700000001/hook')).toThrow(AppError);
      });

      it('shorthand dotted notation for 127.0.0.1 (127.1)', () => {
        expect(() => assertSafeWebhookUrl('http://127.1/hook')).toThrow(AppError);
      });
    });

    describe('IPv4-mapped/compatible IPv6 (the embedded IPv4 must still be checked)', () => {
      it('::ffff:127.0.0.1 (IPv4-mapped loopback)', () => {
        expect(() => assertSafeWebhookUrl('http://[::ffff:127.0.0.1]/hook')).toThrow(AppError);
      });

      it('::ffff:169.254.169.254 (IPv4-mapped cloud metadata)', () => {
        expect(() => assertSafeWebhookUrl('http://[::ffff:169.254.169.254]/hook')).toThrow(AppError);
      });

      it('::ffff:10.0.0.5 (IPv4-mapped private range)', () => {
        expect(() => assertSafeWebhookUrl('http://[::ffff:10.0.0.5]/hook')).toThrow(AppError);
      });
    });
  });

  describe('rejects dangerous ports', () => {
    it('a well-known internal-service port (5432 Postgres)', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:5432/hook')).toThrow(AppError);
    });

    it('a well-known internal-service port (6379 Redis)', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:6379/hook')).toThrow(AppError);
    });

    it('SSH (22)', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:22/hook')).toThrow(AppError);
    });
  });
});

describe('resolveSafeWebhookTarget (DNS resolution + rebinding protection)', () => {
  beforeEach(() => {
    dnsMock.resolve4.mockReset();
    dnsMock.resolve6.mockReset();
  });

  it('a literal IP address never touches DNS at all', async () => {
    const result = await resolveSafeWebhookTarget(new URL('https://93.184.216.34/hook'));
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
    expect(dnsMock.resolve4).not.toHaveBeenCalled();
    expect(dnsMock.resolve6).not.toHaveBeenCalled();
  });

  it('resolves a hostname to its safe public IPv4 address', async () => {
    dnsMock.resolve4.mockResolvedValueOnce(['93.184.216.34']);
    dnsMock.resolve6.mockRejectedValueOnce(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

    const result = await resolveSafeWebhookTarget(new URL('https://api.example.com/hook'));
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('prefers IPv4 when both families resolve safely', async () => {
    dnsMock.resolve4.mockResolvedValueOnce(['93.184.216.34']);
    dnsMock.resolve6.mockResolvedValueOnce(['2606:2800:220:1:248:1893:25c8:1946']);

    const result = await resolveSafeWebhookTarget(new URL('https://api.example.com/hook'));
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('rejects (SsrfBlockedError) when the hostname resolves ONLY to a private address — simulated DNS-rebinding target', async () => {
    dnsMock.resolve4.mockResolvedValueOnce(['10.0.0.5']);
    dnsMock.resolve6.mockRejectedValueOnce(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

    await expect(resolveSafeWebhookTarget(new URL('https://rebinding.example.com/hook'))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('rejects (fail-closed) when a hostname resolves to a MIX of safe and unsafe addresses — one bad answer blocks the whole target', async () => {
    dnsMock.resolve4.mockResolvedValueOnce(['93.184.216.34', '169.254.169.254']);
    dnsMock.resolve6.mockRejectedValueOnce(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

    await expect(resolveSafeWebhookTarget(new URL('https://mixed.example.com/hook'))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('rejects a hostname that resolves only to a private IPv6 address', async () => {
    dnsMock.resolve4.mockRejectedValueOnce(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    dnsMock.resolve6.mockResolvedValueOnce(['fc00::1']);

    await expect(resolveSafeWebhookTarget(new URL('https://v6-private.example.com/hook'))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('rejects a hostname that resolves to the cloud metadata address', async () => {
    dnsMock.resolve4.mockResolvedValueOnce(['169.254.169.254']);
    dnsMock.resolve6.mockRejectedValueOnce(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

    await expect(resolveSafeWebhookTarget(new URL('https://metadata.example.com/hook'))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('throws a plain Error (not SsrfBlockedError) when DNS resolution fails entirely — caller treats this as a transient fault, not a policy block', async () => {
    dnsMock.resolve4.mockRejectedValueOnce(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    dnsMock.resolve6.mockRejectedValueOnce(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));

    await expect(resolveSafeWebhookTarget(new URL('https://nxdomain.example.com/hook'))).rejects.not.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('still runs the literal/syntax checks first (dangerous port rejected before any DNS lookup)', async () => {
    await expect(resolveSafeWebhookTarget(new URL('https://api.example.com:5432/hook'))).rejects.toBeInstanceOf(
      AppError,
    );
    expect(dnsMock.resolve4).not.toHaveBeenCalled();
  });
});

// ── Audit remediation F04 (HTTPS only in production) and F06 (IPv6 transition forms) ──

describe('production protocol policy (F04)', () => {
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.WEBHOOK_ALLOW_INSECURE_HTTP;
    dnsMock.resolve4.mockReset();
    dnsMock.resolve6.mockReset();
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('rejects a public http URL at registration/update time with a stable reason', () => {
    try {
      assertSafeWebhookUrl('http://api.myclinic.example/hooks');
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).message).toMatch(/https/i);
    }
  });

  it.each([
    'HTTP://api.myclinic.example/hooks',
    'http://api.myclinic.example:443/hooks',
    'http://api.myclinic.example@evil.example/hooks',
  ])('rejects scheme/port variants: %s', (url) => {
    expect(() => assertSafeWebhookUrl(url)).toThrow(AppError);
  });

  it('still accepts https', () => {
    expect(() => assertSafeWebhookUrl('https://api.myclinic.example/hooks')).not.toThrow();
  });

  it('refuses at DELIVERY time too (legacy stored http endpoint)', async () => {
    await expect(resolveSafeWebhookTarget(new URL('http://93.184.216.34/hook'))).rejects.toBeInstanceOf(AppError);
    expect(dnsMock.resolve4).not.toHaveBeenCalled();
  });

  it('honours the backend-only escape hatch (not a request field)', () => {
    process.env.WEBHOOK_ALLOW_INSECURE_HTTP = 'true';
    expect(() => assertSafeWebhookUrl('http://api.myclinic.example/hooks')).not.toThrow();
  });

  it('WEBHOOK_ALLOW_INSECURE_HTTP=false enforces https outside production too (staging / tests)', () => {
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_ALLOW_INSECURE_HTTP = 'false';
    expect(() => assertSafeWebhookUrl('http://api.myclinic.example/hooks')).toThrow(AppError);
    expect(() => assertSafeWebhookUrl('https://api.myclinic.example/hooks')).not.toThrow();
  });

  it('keeps blocking private targets even with the escape hatch', () => {
    process.env.WEBHOOK_ALLOW_INSECURE_HTTP = 'true';
    expect(() => assertSafeWebhookUrl('http://127.0.0.1/hooks')).toThrow(AppError);
  });
});

describe('IPv6 transition mechanisms embed an IPv4 target (F06)', () => {
  beforeEach(() => {
    dnsMock.resolve4.mockReset();
    dnsMock.resolve6.mockReset();
  });

  it.each([
    ['NAT64 of 127.0.0.1 (audit literal)', 'https://[64:ff9b::7f00:1]/'],
    ['NAT64 of 169.254.169.254 (audit literal)', 'https://[64:ff9b::a9fe:a9fe]/'],
    ['6to4 of 127.0.0.1 (audit literal)', 'https://[2002:7f00:1::]/'],
    ['NAT64 expanded + zero padded', 'https://[0064:ff9b:0000:0000:0000:0000:7f00:0001]/'],
    ['NAT64 upper case', 'https://[64:FF9B::A9FE:A9FE]/'],
    ['NAT64 of 10.0.0.5', 'https://[64:ff9b::a00:5]/'],
    ['6to4 of 192.168.1.1', 'https://[2002:c0a8:101::1]/'],
    ['6to4 expanded', 'https://[2002:7f00:0001:0000:0000:0000:0000:0000]/'],
    ['local-use NAT64 64:ff9b:1::/48', 'https://[64:ff9b:1::5db8:d822]/'],
    ['Teredo 2001:0::/32', 'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/'],
  ])('registration blocks %s', (_n, url) => {
    expect(() => assertSafeWebhookUrl(url)).toThrow(AppError);
  });

  it('allows NAT64 of a public IPv4 and an ordinary public IPv6', () => {
    expect(() => assertSafeWebhookUrl('https://[64:ff9b::5db8:d822]/')).not.toThrow(); // 93.184.216.34
    expect(() => assertSafeWebhookUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/')).not.toThrow();
  });

  it('delivery-time: a literal NAT64 loopback is a permanent SsrfBlockedError', async () => {
    await expect(resolveSafeWebhookTarget(new URL('https://[64:ff9b::7f00:1]/'))).rejects.toBeInstanceOf(AppError);
  });

  it('delivery-time: an AAAA answer in a transition range blocks the whole target', async () => {
    dnsMock.resolve4.mockRejectedValueOnce(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    dnsMock.resolve6.mockResolvedValueOnce(['64:ff9b::a9fe:a9fe']);
    await expect(resolveSafeWebhookTarget(new URL('https://rebind.example.com/hook'))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});
