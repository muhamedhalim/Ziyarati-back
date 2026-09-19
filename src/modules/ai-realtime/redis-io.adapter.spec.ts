import { createServer } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import { Adapter } from 'socket.io-adapter';

type Handler = (...args: unknown[]) => void;

class FakeRedis {
  static instances: FakeRedis[] = [];
  handlers = new Map<string, Handler>();
  constructor(
    public readonly urlOrOpts: unknown,
    public readonly opts?: Record<string, unknown>,
  ) {
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

jest.mock('ioredis', () => ({
  Redis: jest.fn(
    (...args: unknown[]) =>
      new FakeRedis(args[0], args[1] as Record<string, unknown>),
  ),
}));
jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: jest.fn(() => 'adapter-instance'),
}));

import { RedisIoAdapter } from './redis-io.adapter';

describe('RedisIoAdapter', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const fakeApp = (redisUrl: string | undefined) => ({
    get: (token: unknown) =>
      token === ConfigService
        ? ({
            get: (k: string) => (k === 'REDIS_URL' ? redisUrl : undefined),
          } as unknown as ConfigService)
        : undefined,
  });

  it('attaches an error listener to BOTH the pub and sub clients — an unhandled ioredis "error" event can otherwise crash the whole API process', async () => {
    const adapter = new RedisIoAdapter(
      fakeApp('redis://localhost:6379') as never,
    );
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

/**
 * CSWSH: `createIOServer` is where every gateway's Socket.IO server is built
 * (Nest's `IoAdapter.create` routes all of them through it), so it is where
 * handshake admission is installed. The wire-level proof — real sockets, both
 * transports — is `test/security/ws-cswsh-handshake.spec.ts`; this pins the
 * wiring itself: which list it reads, that it survives clustering, and that it
 * cannot be loosened by an `allowRequest` added later.
 */
describe('RedisIoAdapter.createIOServer — handshake admission', () => {
  type AllowRequest = (
    req: { headers: Record<string, string | undefined> },
    cb: (message: string | null | undefined, ok: boolean) => void,
  ) => void;
  type Built = {
    engine: { opts: { allowRequest?: AllowRequest; transports: string[] } };
  };

  const saved = {
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
    API_CLUSTER_WORKERS: process.env.API_CLUSTER_WORKERS,
  };
  const built: { close: (cb?: () => void) => void }[] = [];

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const io of built.splice(0)) {
      try {
        io.close(() => undefined);
      } catch {
        /* the http server was never listening */
      }
    }
  });

  const build = (options?: Record<string, unknown>) => {
    const adapter = new RedisIoAdapter(createServer() as never);
    const io = adapter.createIOServer(
      0,
      options as never,
    ) as unknown as Built & {
      close: (cb?: () => void) => void;
    };
    built.push(io);
    return io;
  };

  const admit = (io: Built, headers: Record<string, string | undefined>) =>
    new Promise<{ ok: boolean; message?: string | null }>((resolve) =>
      io.engine.opts.allowRequest!({ headers }, (message, ok) =>
        resolve({ ok, message }),
      ),
    );

  it('still attaches the Redis adapter to the server it builds, with admission installed alongside it', async () => {
    // `Server.adapter()` must receive a constructor; the file-level mock hands
    // back a string, so hand back a real (empty) Adapter subclass for this case.
    class FakeRedisAdapter extends Adapter {}
    jest.mocked(createAdapter).mockReturnValueOnce(FakeRedisAdapter as never);
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    // One object plays both roles the adapter asks of `app`: it is the http
    // server `createIOServer(0)` binds to, and it answers `app.get(ConfigService)`
    // for `connectToRedis`.
    const httpAndApp = Object.assign(createServer(), {
      get: (token: unknown) =>
        token === ConfigService
          ? {
              get: (k: string) =>
                k === 'REDIS_URL' ? 'redis://localhost:6379' : undefined,
            }
          : undefined,
    });
    const adapter = new RedisIoAdapter(httpAndApp as never);
    await adapter.connectToRedis();

    const io = adapter.createIOServer(0, {} as never) as unknown as Built & {
      close: (cb?: () => void) => void;
      of: (nsp: string) => { adapter: unknown };
    };
    built.push(io);

    expect(io.of('/ai').adapter).toBeInstanceOf(FakeRedisAdapter);
    await expect(
      admit(io, { origin: 'https://attacker.example' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      admit(io, { origin: 'https://app.example.com' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('installs an allowRequest on the engine it creates', () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    expect(typeof build().engine.opts.allowRequest).toBe('function');
  });

  it('admits the configured origin and refuses every other, with a fixed message that reflects nothing from the request', async () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    const io = build();
    await expect(
      admit(io, { origin: 'https://app.example.com' }),
    ).resolves.toMatchObject({ ok: true });
    const refused = await admit(io, {
      origin: 'https://attacker.example',
      cookie: 'a=b',
    });
    expect(refused).toEqual({ ok: false, message: 'Origin not allowed' });
  });

  it('reads the allow-list through parseAllowedOrigins, so a trailing slash cannot make it match nothing', async () => {
    process.env.FRONTEND_ORIGIN =
      'https://app.example.com/, https://book.example.com';
    const io = build();
    await expect(
      admit(io, { origin: 'https://app.example.com' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      admit(io, { origin: 'https://book.example.com' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('falls back to the development origin only when FRONTEND_ORIGIN is unset — the same default REST CORS uses', async () => {
    delete process.env.FRONTEND_ORIGIN;
    const io = build();
    await expect(
      admit(io, { origin: 'http://localhost:3000' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      admit(io, { origin: 'http://localhost:9999' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('refuses null, a missing Origin with a cookie, and a cross-site Sec-Fetch-Site', async () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    const io = build();
    await expect(admit(io, { origin: 'null' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(admit(io, { cookie: 'access_token=x' })).resolves.toEqual({
      ok: false,
      message: 'Origin required',
    });
    await expect(
      admit(io, {
        origin: 'https://app.example.com',
        'sec-fetch-site': 'cross-site',
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Cross-site request not allowed',
    });
  });

  it('admits a missing Origin with no cookie (an explicit-token native or test client)', async () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    await expect(admit(build(), {})).resolves.toMatchObject({ ok: true });
  });

  it('is installed in clustered (websocket-only) mode as well — the branch that rewrites the options', async () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    process.env.API_CLUSTER_WORKERS = '4';
    const io = build();
    expect(io.engine.opts.transports).toEqual(['websocket']);
    await expect(
      admit(io, { origin: 'https://attacker.example' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      admit(io, { origin: 'https://app.example.com' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('leaves the transports alone when not clustered — polling stays available', () => {
    delete process.env.API_CLUSTER_WORKERS;
    expect(build().engine.opts.transports).toEqual(['polling', 'websocket']);
  });

  it('runs an existing allowRequest only AFTER its own check, so a later one can tighten but never loosen it', async () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    const downstream = jest.fn(
      (_req: unknown, cb: (m: string | null, ok: boolean) => void) =>
        cb(null, true),
    );
    const io = build({ allowRequest: downstream });

    await expect(
      admit(io, { origin: 'https://attacker.example' }),
    ).resolves.toMatchObject({ ok: false });
    expect(downstream).not.toHaveBeenCalled(); // even a downstream that says yes never gets asked

    await expect(
      admit(io, { origin: 'https://app.example.com' }),
    ).resolves.toMatchObject({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it('lets a downstream allowRequest veto an origin the allow-list admitted', async () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    const io = build({
      allowRequest: (
        _req: unknown,
        cb: (m: string | null, ok: boolean) => void,
      ) => cb('no', false),
    });
    await expect(
      admit(io, { origin: 'https://app.example.com' }),
    ).resolves.toEqual({ ok: false, message: 'no' });
  });

  it('does not mutate the options object the caller passed in', () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    const options = {
      cors: { origin: ['https://app.example.com'], credentials: true },
    };
    build(options);
    expect(options).toEqual({
      cors: { origin: ['https://app.example.com'], credentials: true },
    });
  });
});
