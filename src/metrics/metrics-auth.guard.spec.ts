import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MetricsAuthGuard } from './metrics-auth.guard';

function buildContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function buildConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('MetricsAuthGuard (M14)', () => {
  it('allows any request when METRICS_TOKEN is unset outside production (dev convenience)', () => {
    const guard = new MetricsAuthGuard(
      buildConfig({ NODE_ENV: 'development' }),
    );
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it('fails CLOSED when METRICS_TOKEN is unset in production', () => {
    const guard = new MetricsAuthGuard(buildConfig({ NODE_ENV: 'production' }));
    expect(() => guard.canActivate(buildContext())).toThrow(
      UnauthorizedException,
    );
  });

  it('allows a request presenting the correct bearer token', () => {
    const guard = new MetricsAuthGuard(
      buildConfig({ NODE_ENV: 'production', METRICS_TOKEN: 'secret-1' }),
    );
    expect(
      guard.canActivate(buildContext({ authorization: 'Bearer secret-1' })),
    ).toBe(true);
  });

  it('rejects a request presenting the wrong bearer token', () => {
    const guard = new MetricsAuthGuard(
      buildConfig({ NODE_ENV: 'production', METRICS_TOKEN: 'secret-1' }),
    );
    expect(() =>
      guard.canActivate(buildContext({ authorization: 'Bearer wrong' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a request with no Authorization header at all when a token is configured', () => {
    const guard = new MetricsAuthGuard(
      buildConfig({ NODE_ENV: 'development', METRICS_TOKEN: 'secret-1' }),
    );
    expect(() => guard.canActivate(buildContext())).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token of a different length (not just a mismatched value)', () => {
    const guard = new MetricsAuthGuard(
      buildConfig({
        NODE_ENV: 'development',
        METRICS_TOKEN: 'a-long-secret-token',
      }),
    );
    expect(() =>
      guard.canActivate(buildContext({ authorization: 'Bearer short' })),
    ).toThrow(UnauthorizedException);
  });
});
