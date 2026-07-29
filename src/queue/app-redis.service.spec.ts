import { ConfigService } from '@nestjs/config';

type Handler = (...args: unknown[]) => void;

class FakeRedis {
  static instances: FakeRedis[] = [];
  /** Every new instance starts with this — set it BEFORE constructing AppRedisService to control what the very first CONFIG GET sees. */
  static nextConfigResult: [string, string] | Error = ['maxmemory-policy', 'noeviction'];
  handlers = new Map<string, Handler>();
  connectCalled = false;
  configResult: [string, string] | Error;

  constructor(public readonly opts: Record<string, unknown>) {
    this.configResult = FakeRedis.nextConfigResult;
    FakeRedis.instances.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  connect() {
    this.connectCalled = true;
    return Promise.resolve();
  }
  config(_sub: string, _key: string) {
    if (this.configResult instanceof Error) return Promise.reject(this.configResult);
    return Promise.resolve(this.configResult);
  }
  quit() {
    return Promise.resolve();
  }
  emitError(err: Error) {
    this.handlers.get('error')?.(err);
  }
}

jest.mock('ioredis', () => ({ Redis: jest.fn((opts: Record<string, unknown>) => new FakeRedis(opts)) }));

// Import AFTER the mock so the service picks up the mocked constructor.
import { AppRedisService } from './app-redis.service';

const config = {
  get: (k: string) => (k === 'REDIS_URL' ? 'redis://localhost:6379' : undefined),
} as unknown as ConfigService;

describe('AppRedisService', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  it('builds exactly two dedicated clients: application and rateLimiter', () => {
    const service = new AppRedisService(config);
    expect(FakeRedis.instances).toHaveLength(2);
    expect(service.application).toBeDefined();
    expect(service.rateLimiter).toBeDefined();
    expect(service.application).not.toBe(service.rateLimiter);
  });

  it('attaches an error listener to every client — an unhandled ioredis "error" event can crash the process otherwise', () => {
    new AppRedisService(config);
    for (const client of FakeRedis.instances) {
      expect(client.handlers.has('error')).toBe(true);
      // Must not throw when a real error arrives — proves the listener actually swallows it.
      expect(() => client.emitError(new Error('ECONNRESET'))).not.toThrow();
    }
  });

  it('warns when maxmemory-policy is not noeviction (Phase 0 — see original audit C1)', async () => {
    const nestCommon = require('@nestjs/common');
    const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

    FakeRedis.nextConfigResult = ['maxmemory-policy', 'allkeys-lru'];
    new AppRedisService(config);
    await Promise.resolve().then(() => Promise.resolve()); // flush the .config(...).then() chain

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('allkeys-lru'));
    warnSpy.mockRestore();
    FakeRedis.nextConfigResult = ['maxmemory-policy', 'noeviction'];
  });

  it('stays silent when maxmemory-policy is already noeviction', async () => {
    const nestCommon = require('@nestjs/common');
    const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

    FakeRedis.nextConfigResult = ['maxmemory-policy', 'noeviction'];
    new AppRedisService(config);
    await Promise.resolve().then(() => Promise.resolve());

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not throw when CONFIG GET is disallowed by the provider (best-effort check)', async () => {
    FakeRedis.nextConfigResult = new Error('NOPERM this command is not allowed');
    expect(() => new AppRedisService(config)).not.toThrow();
    await Promise.resolve().then(() => Promise.resolve());
    FakeRedis.nextConfigResult = ['maxmemory-policy', 'noeviction'];
  });
});
