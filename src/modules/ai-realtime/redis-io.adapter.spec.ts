import { ConfigService } from '@nestjs/config';

type Handler = (...args: unknown[]) => void;

class FakeRedis {
  static instances: FakeRedis[] = [];
  handlers = new Map<string, Handler>();
  constructor(public readonly urlOrOpts: unknown, public readonly opts?: Record<string, unknown>) {
    FakeRedis.instances.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  connect() {
    return Promise.resolve();
  }
  duplicate(overrides?: Record<string, unknown>) {
    return new FakeRedis(this.urlOrOpts, { ...this.opts, ...overrides });
  }
  emitError(err: Error) {
    this.handlers.get('error')?.(err);
  }
}

jest.mock('ioredis', () => ({ Redis: jest.fn((...args: unknown[]) => new FakeRedis(args[0], args[1] as Record<string, unknown>)) }));
jest.mock('@socket.io/redis-adapter', () => ({ createAdapter: jest.fn(() => 'adapter-instance') }));

import { RedisIoAdapter } from './redis-io.adapter';

describe('RedisIoAdapter', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const fakeApp = (redisUrl: string | undefined) => ({
    get: (token: unknown) =>
      token === ConfigService ? ({ get: (k: string) => (k === 'REDIS_URL' ? redisUrl : undefined) } as unknown as ConfigService) : undefined,
  });

  it('attaches an error listener to BOTH the pub and sub clients — an unhandled ioredis "error" event can otherwise crash the whole API process', async () => {
    const adapter = new RedisIoAdapter(fakeApp('redis://localhost:6379') as never);
    await adapter.connectToRedis();

    expect(FakeRedis.instances).toHaveLength(2); // pub + sub (duplicate)
    for (const client of FakeRedis.instances) {
      expect(client.handlers.has('error')).toBe(true);
      expect(() => client.emitError(new Error('ECONNRESET'))).not.toThrow();
    }
  });

  it('falls back to the in-memory adapter (no throw) when REDIS_URL is unset', async () => {
    const adapter = new RedisIoAdapter(fakeApp(undefined) as never);
    await expect(adapter.connectToRedis()).resolves.toBeUndefined();
    expect(FakeRedis.instances).toHaveLength(0);
  });
});
