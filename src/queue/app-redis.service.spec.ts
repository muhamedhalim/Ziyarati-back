import { ConfigService } from '@nestjs/config';

type Handler = (...args: unknown[]) => void;

class FakeRedis {
  static instances: FakeRedis[] = [];
  /** Every new instance starts with this — set it BEFORE constructing AppRedisService to control what the very first CONFIG GET (maxmemory-policy) sees. */
  static nextConfigResult: [string, string] | Error = ['maxmemory-policy', 'noeviction'];
  /** Separate knob for the maxmemory (ceiling) CONFIG GET, keyed independently of the policy one above. */
  static nextMaxmemoryResult: [string, string] | Error = ['maxmemory', '536870912'];
  /** Set to something other than 'ready' to exercise the onModuleInit "not ready in time" path. */
  static nextStatus: string = 'ready';
  handlers = new Map<string, Handler>();
  connectCalled = false;
  configResult: [string, string] | Error;
  maxmemoryResult: [string, string] | Error;
  status: string;

  constructor(public readonly opts: Record<string, unknown>) {
    this.configResult = FakeRedis.nextConfigResult;
    this.maxmemoryResult = FakeRedis.nextMaxmemoryResult;
    this.status = FakeRedis.nextStatus;
    FakeRedis.instances.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  off(event: string) {
    this.handlers.delete(event);
    return this;
  }
  once(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  connect() {
    this.connectCalled = true;
    return Promise.resolve();
  }
  config(_sub: string, key: string) {
    const result = key === 'maxmemory' ? this.maxmemoryResult : this.configResult;
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
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

const prodConfig = {
  get: (k: string) => {
    if (k === 'REDIS_URL') return 'redis://localhost:6379';
    if (k === 'NODE_ENV') return 'production';
    return undefined;
  },
} as unknown as ConfigService;

const prodConfigUnsafeAllowed = {
  get: (k: string) => {
    if (k === 'REDIS_URL') return 'redis://localhost:6379';
    if (k === 'NODE_ENV') return 'production';
    if (k === 'REDIS_ALLOW_UNSAFE_MEMORY_CONFIG') return 'true';
    return undefined;
  },
} as unknown as ConfigService;

describe('AppRedisService', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
    FakeRedis.nextConfigResult = ['maxmemory-policy', 'noeviction'];
    FakeRedis.nextMaxmemoryResult = ['maxmemory', '536870912'];
    FakeRedis.nextStatus = 'ready';
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

  describe('onModuleInit — maxmemory-policy check (Phase 0 — original audit C1; enforcement added §0.8.9)', () => {
    it('outside production: WARNS (does not throw) when maxmemory-policy is not noeviction', async () => {
      const nestCommon = require('@nestjs/common');
      const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

      FakeRedis.nextConfigResult = ['maxmemory-policy', 'allkeys-lru'];
      const service = new AppRedisService(config);
      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('allkeys-lru'));
      warnSpy.mockRestore();
    });

    it('stays silent when maxmemory-policy is already noeviction', async () => {
      const nestCommon = require('@nestjs/common');
      const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

      const service = new AppRedisService(config);
      await service.onModuleInit();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not throw when CONFIG GET is disallowed by the provider (best-effort check)', async () => {
      FakeRedis.nextConfigResult = new Error('NOPERM this command is not allowed');
      const service = new AppRedisService(config);
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('PRODUCTION ENFORCEMENT: throws (refuses to boot) when maxmemory-policy is unsafe and no escape hatch is set', async () => {
      FakeRedis.nextConfigResult = ['maxmemory-policy', 'allkeys-lru'];
      const service = new AppRedisService(prodConfig);
      await expect(service.onModuleInit()).rejects.toThrow(/allkeys-lru/);
    });

    it('the escape hatch (REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true) downgrades production back to a warning', async () => {
      const nestCommon = require('@nestjs/common');
      const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

      FakeRedis.nextConfigResult = ['maxmemory-policy', 'allkeys-lru'];
      const service = new AppRedisService(prodConfigUnsafeAllowed);
      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('allkeys-lru'));
      warnSpy.mockRestore();
    });
  });

  describe('onModuleInit — maxmemory ceiling check (gap-closure pass — §0.8.9)', () => {
    it('outside production: stays silent even when maxmemory is unlimited (dev default)', async () => {
      const nestCommon = require('@nestjs/common');
      const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

      FakeRedis.nextMaxmemoryResult = ['maxmemory', '0'];
      const service = new AppRedisService(config);
      await service.onModuleInit();

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('maxmemory is unset/unlimited'));
      warnSpy.mockRestore();
    });

    it('stays silent in production when maxmemory has a real ceiling', async () => {
      const nestCommon = require('@nestjs/common');
      const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

      const service = new AppRedisService(prodConfig);
      await service.onModuleInit();

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('maxmemory is unset/unlimited'));
      warnSpy.mockRestore();
    });

    it('does not throw when the maxmemory CONFIG GET is disallowed by the provider', async () => {
      FakeRedis.nextMaxmemoryResult = new Error('NOPERM this command is not allowed');
      const service = new AppRedisService(prodConfig);
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('PRODUCTION ENFORCEMENT: throws (refuses to boot) when maxmemory is unset/unlimited and no escape hatch is set', async () => {
      FakeRedis.nextMaxmemoryResult = ['maxmemory', '0'];
      const service = new AppRedisService(prodConfig);
      await expect(service.onModuleInit()).rejects.toThrow(/unset\/unlimited/);
    });

    it('the escape hatch (REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true) downgrades production back to a warning', async () => {
      const nestCommon = require('@nestjs/common');
      const warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);

      FakeRedis.nextMaxmemoryResult = ['maxmemory', '0'];
      const service = new AppRedisService(prodConfigUnsafeAllowed);
      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unset/unlimited'));
      warnSpy.mockRestore();
    });
  });

  describe('onModuleInit — client-not-ready fallback', () => {
    it('skips both checks (does not throw, even in production) when the client never becomes ready within the timeout', async () => {
      jest.useFakeTimers();
      try {
        FakeRedis.nextStatus = 'connecting'; // never 'ready', never emits 'ready'
        FakeRedis.nextConfigResult = ['maxmemory-policy', 'allkeys-lru']; // would normally throw in prod
        const service = new AppRedisService(prodConfig);
        const p = service.onModuleInit();
        await jest.advanceTimersByTimeAsync(5000);
        await expect(p).resolves.toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
