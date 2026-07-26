import { AppError } from '../../../common/errors';
import {
  allowInsecureBaseUrlScheme,
  allowPrivateBaseUrlHost,
  assertSafeIntegrationBaseUrl,
  normalizeBaseUrl,
  resolveSafeIntegrationTarget,
  SsrfBlockedError,
} from './integration-url-guard';

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PROD_STRICT = { NODE_ENV: 'production', INTEGRATION_ALLOW_INSECURE_BASE_URL: undefined, INTEGRATION_ALLOW_PRIVATE_BASE_URL: undefined };

describe('normalizeBaseUrl', () => {
  it('trims and strips trailing slashes', () => {
    expect(normalizeBaseUrl('  https://api.example.com/v1///  ')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });
});

describe('assertSafeIntegrationBaseUrl — non-production (dev/test) defaults', () => {
  it('allows http and private/loopback hosts by default outside production', async () => {
    await withEnv({ NODE_ENV: 'test', INTEGRATION_ALLOW_INSECURE_BASE_URL: undefined, INTEGRATION_ALLOW_PRIVATE_BASE_URL: undefined }, () => {
      expect(() => assertSafeIntegrationBaseUrl('http://localhost:4000')).not.toThrow();
      expect(() => assertSafeIntegrationBaseUrl('http://192.168.1.5')).not.toThrow();
      expect(allowInsecureBaseUrlScheme()).toBe(true);
      expect(allowPrivateBaseUrlHost()).toBe(true);
    });
  });
});

describe('assertSafeIntegrationBaseUrl — production defaults', () => {
  it('requires https', async () => {
    await withEnv(PROD_STRICT, () => {
      expect(() => assertSafeIntegrationBaseUrl('http://api.example.com')).toThrow(/https/);
      expect(() => assertSafeIntegrationBaseUrl('https://api.example.com')).not.toThrow();
    });
  });

  it('blocks loopback/localhost', async () => {
    await withEnv(PROD_STRICT, () => {
      expect(() => assertSafeIntegrationBaseUrl('https://localhost')).toThrow(/loopback/);
      expect(() => assertSafeIntegrationBaseUrl('https://foo.localhost')).toThrow(/loopback/);
      expect(() => assertSafeIntegrationBaseUrl('https://127.0.0.1')).toThrow(/blocked IPv4/);
    });
  });

  it('blocks internal/private hostnames and IP ranges', async () => {
    await withEnv(PROD_STRICT, () => {
      expect(() => assertSafeIntegrationBaseUrl('https://pms.internal')).toThrow(/internal/);
      expect(() => assertSafeIntegrationBaseUrl('https://svc.local')).toThrow(/internal/);
      expect(() => assertSafeIntegrationBaseUrl('https://10.0.0.5')).toThrow(/blocked IPv4/);
      expect(() => assertSafeIntegrationBaseUrl('https://192.168.1.5')).toThrow(/blocked IPv4/);
      expect(() => assertSafeIntegrationBaseUrl('https://172.16.0.1')).toThrow(/blocked IPv4/);
      expect(() => assertSafeIntegrationBaseUrl('https://169.254.169.254')).toThrow(/blocked IPv4/); // cloud metadata
    });
  });

  it('blocks blocked IPv6 ranges (loopback, unique-local, link-local)', async () => {
    await withEnv(PROD_STRICT, () => {
      expect(() => assertSafeIntegrationBaseUrl('https://[::1]')).toThrow(/blocked IPv6/);
      expect(() => assertSafeIntegrationBaseUrl('https://[fd00::1]')).toThrow(/blocked IPv6/);
      expect(() => assertSafeIntegrationBaseUrl('https://[fe80::1]')).toThrow(/blocked IPv6/);
    });
  });

  it('blocks dangerous ports, embedded credentials, and query/fragment', async () => {
    await withEnv(PROD_STRICT, () => {
      expect(() => assertSafeIntegrationBaseUrl('https://api.example.com:6379')).toThrow(/port 6379/);
      expect(() => assertSafeIntegrationBaseUrl('https://user:pass@api.example.com')).toThrow(/credentials/);
      expect(() => assertSafeIntegrationBaseUrl('https://api.example.com?x=1')).toThrow(/query string/);
      expect(() => assertSafeIntegrationBaseUrl('https://api.example.com#frag')).toThrow(/query string/);
    });
  });

  it('rejects a malformed URL', async () => {
    await withEnv(PROD_STRICT, () => {
      expect(() => assertSafeIntegrationBaseUrl('not a url')).toThrow(/not a valid URL/);
    });
  });

  it('honours explicit env overrides', async () => {
    await withEnv({ ...PROD_STRICT, INTEGRATION_ALLOW_INSECURE_BASE_URL: 'true' }, () => {
      expect(() => assertSafeIntegrationBaseUrl('http://api.example.com')).not.toThrow();
    });
    await withEnv({ ...PROD_STRICT, INTEGRATION_ALLOW_PRIVATE_BASE_URL: 'true' }, () => {
      expect(() => assertSafeIntegrationBaseUrl('https://10.0.0.5')).not.toThrow();
    });
  });
});

describe('resolveSafeIntegrationTarget', () => {
  it('pins a literal-IPv4 host directly, no DNS lookup needed', async () => {
    await withEnv({ NODE_ENV: 'test' }, async () => {
      const target = await resolveSafeIntegrationTarget(new URL('http://93.184.216.34'));
      expect(target).toEqual({ address: '93.184.216.34', family: 4 });
    });
  });

  it('rejects a blocked literal IPv4 address in production (caught by the layer-1 literal check, AppError)', async () => {
    await withEnv(PROD_STRICT, async () => {
      await expect(resolveSafeIntegrationTarget(new URL('https://127.0.0.1'))).rejects.toThrow(AppError);
    });
  });

  it('rejects a hostname that DNS-resolves to a blocked address with SsrfBlockedError (closes the DNS-rebinding window)', async () => {
    jest.resetModules();
    jest.doMock('node:dns', () => ({
      promises: {
        resolve4: jest.fn().mockResolvedValue(['10.0.0.7']),
        resolve6: jest.fn().mockRejectedValue(new Error('no AAAA')),
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./integration-url-guard') as typeof import('./integration-url-guard');
    await withEnv(PROD_STRICT, async () => {
      await expect(mod.resolveSafeIntegrationTarget(new URL('https://pms.tenant-hosted.example.com'))).rejects.toThrow(
        mod.SsrfBlockedError,
      );
    });
    jest.dontMock('node:dns');
    jest.resetModules();
  });

  it('resolves a real hostname and pins a safe address (network-dependent; tolerant if offline)', async () => {
    await withEnv({ NODE_ENV: 'test' }, async () => {
      try {
        const target = await resolveSafeIntegrationTarget(new URL('https://example.com'));
        expect(['4', '6']).toContain(String(target.family));
        expect(typeof target.address).toBe('string');
      } catch (err) {
        // No network in this environment — acceptable; the guard's own logic
        // is already covered by the literal-address assertions above.
        expect((err as Error).message).toMatch(/resolve|ENOTFOUND|EAI_AGAIN/i);
      }
    });
  });
});
