import { of, throwError, lastValueFrom } from 'rxjs';

import { ApiLoggingInterceptor } from './api-logging.interceptor';

/**
 * Phase 2.1 — the sampling/skip policy is now behaviour, so it gets tests.
 *
 * It had none, which is how the skip pattern shipped matching nothing: it was
 * written without the `api/v1` global prefix that `req.path` actually carries,
 * so every health probe and Prometheus scrape wrote an `api_logs` row.
 */
describe('ApiLoggingInterceptor', () => {
  const record = jest.fn().mockResolvedValue(undefined);

  const build = (env: Record<string, string | undefined>, principalId?: string) =>
    new ApiLoggingInterceptor(
      { record } as never,
      {
        getTenantId: () => 'tenant-1',
        getUser: () => (principalId ? { id: principalId } : undefined),
      } as never,
      { get: (k: string) => env[k] } as never,
    );

  const ctx = (path: string, statusCode = 200) =>
    ({
      getType: () => 'http',
      getClass: () => ({ name: 'SomeController' }),
      switchToHttp: () => ({
        getRequest: () => ({ path, method: 'GET', ip: '10.0.0.1', route: { path } }),
        getResponse: () => ({ statusCode }),
      }),
    }) as never;

  const run = async (
    interceptor: ApiLoggingInterceptor,
    path: string,
    statusCode = 200,
  ) => {
    await lastValueFrom(
      interceptor.intercept(ctx(path, statusCode), { handle: () => of('ok') } as never),
    );
  };

  beforeEach(() => record.mockClear());

  describe('skip list', () => {
    // The regression this whole phase started from.
    it.each([
      '/api/v1/system/health/readiness',
      '/api/v1/system/health/liveness',
      '/api/v1/metrics',
      '/api/v1/docs',
      '/api/v1/favicon.ico',
      // Prefix-less form must keep working — the worker root mounts no prefix.
      '/metrics',
      '/system/health',
    ])('never records %s', async (path) => {
      await run(build({}), path);
      expect(record).not.toHaveBeenCalled();
    });

    it('still records a normal application route', async () => {
      await run(build({}), '/api/v1/appointments');
      expect(record).toHaveBeenCalledTimes(1);
    });

    // Guard against a lazier pattern that would match any path CONTAINING the
    // word — `/api/v1/tenants/docs` is a real route, not a docs mount.
    it('does not skip a route that merely contains a skipped word', async () => {
      await run(build({}), '/api/v1/tenants/docs');
      expect(record).toHaveBeenCalledTimes(1);
    });
  });

  describe('sampling policy', () => {
    it('records nothing when disabled', async () => {
      await run(build({ PLATFORM_API_LOG_ENABLED: 'false' }), '/api/v1/appointments');
      expect(record).not.toHaveBeenCalled();
    });

    it('defaults to disabled under NODE_ENV=test so load runs are deterministic', async () => {
      await run(build({ NODE_ENV: 'test' }), '/api/v1/appointments');
      expect(record).not.toHaveBeenCalled();
    });

    it('an explicit opt-in still enables it under NODE_ENV=test', async () => {
      await run(
        build({ NODE_ENV: 'test', PLATFORM_API_LOG_ENABLED: 'true' }),
        '/api/v1/appointments',
      );
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('defaults to a 0.1 sample in production', async () => {
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5); // > 0.1 => drop
      await run(build({ NODE_ENV: 'production' }), '/api/v1/appointments');
      expect(record).not.toHaveBeenCalled();
      spy.mockReturnValue(0.05); // < 0.1 => keep
      await run(build({ NODE_ENV: 'production' }), '/api/v1/appointments');
      expect(record).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('does not sample at all when sample >= 1 (no Math.random call)', async () => {
      const spy = jest.spyOn(Math, 'random');
      await run(build({ PLATFORM_API_LOG_SAMPLE: '1' }), '/api/v1/appointments');
      expect(record).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    // The two carve-outs: sampling must never hide an error or corrupt
    // per-API-key usage metering, which is what api_logs exists for.
    it('ALWAYS records a >=400 response even at sample 0', async () => {
      await run(build({ PLATFORM_API_LOG_SAMPLE: '0' }), '/api/v1/appointments', 403);
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('ALWAYS records an API-key request even at sample 0', async () => {
      await run(
        build({ PLATFORM_API_LOG_SAMPLE: '0' }, 'apikey:key-123'),
        '/api/v1/integration/appointments',
      );
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][1]).toMatchObject({ apiKeyId: 'key-123' });
    });

    it('drops ordinary sampled-out traffic at sample 0', async () => {
      await run(build({ PLATFORM_API_LOG_SAMPLE: '0' }), '/api/v1/appointments', 200);
      expect(record).not.toHaveBeenCalled();
    });
  });

  it('records the mapped status when the handler errors', async () => {
    const interceptor = build({});
    await expect(
      lastValueFrom(
        interceptor.intercept(ctx('/api/v1/appointments'), {
          handle: () => throwError(() => ({ status: 409 })),
        } as never),
      ),
    ).rejects.toBeDefined();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toMatchObject({ statusCode: 409 });
  });

  it('never lets a logging failure escape into the request', async () => {
    record.mockRejectedValueOnce(new Error('db down'));
    await expect(run(build({}), '/api/v1/appointments')).resolves.toBeUndefined();
  });
});
