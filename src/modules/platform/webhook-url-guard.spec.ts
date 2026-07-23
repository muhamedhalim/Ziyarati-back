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
