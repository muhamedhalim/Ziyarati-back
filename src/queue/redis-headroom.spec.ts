import { parseRedisMemory, RedisHeadroomProbe } from './redis-headroom';

const info = (used: number, max: number) =>
  `# Memory\r\nused_memory:${used}\r\nused_memory_human:1M\r\nmaxmemory:${max}\r\nmaxmemory_policy:noeviction\r\n`;

describe('parseRedisMemory (RL-08)', () => {
  it('reads used_memory and maxmemory from an INFO memory reply', () => {
    expect(parseRedisMemory(info(400, 1000))).toEqual({ used: 400, max: 1000 });
  });

  it('does not confuse used_memory with used_memory_peak or _rss', () => {
    const reply =
      'used_memory_peak:900\r\nused_memory_rss:800\r\nused_memory:100\r\nmaxmemory:1000\r\n';
    expect(parseRedisMemory(reply)).toEqual({ used: 100, max: 1000 });
  });

  it('returns null for an unbounded Redis (maxmemory 0) or an unparseable reply', () => {
    expect(parseRedisMemory(info(400, 0))).toBeNull();
    expect(parseRedisMemory('garbage')).toBeNull();
  });
});

describe('RedisHeadroomProbe (RL-08)', () => {
  let now = 0;
  const probe = (reply: () => Promise<string>, maxPercent = 85) =>
    new RedisHeadroomProbe({
      info: reply,
      maxPercent,
      cacheMs: 5_000,
      now: () => now,
    });

  beforeEach(() => {
    now = 0;
  });

  it('has headroom below the threshold and none at or above it', async () => {
    await expect(
      probe(async () => info(840, 1000)).hasHeadroom(),
    ).resolves.toBe(true);
    await expect(
      probe(async () => info(850, 1000)).hasHeadroom(),
    ).resolves.toBe(false);
  });

  it('fails open when INFO errors or Redis is unbounded', async () => {
    await expect(
      probe(async () => Promise.reject(new Error('timeout'))).hasHeadroom(),
    ).resolves.toBe(true);
    await expect(probe(async () => info(999, 0)).hasHeadroom()).resolves.toBe(
      true,
    );
  });

  it('reuses one reading within the cache window and shares a concurrent read', async () => {
    const reply = jest.fn(async () => info(100, 1000));
    const p = probe(reply);
    await Promise.all([p.hasHeadroom(), p.hasHeadroom(), p.hasHeadroom()]);
    now = 4_999;
    await p.hasHeadroom();
    expect(reply).toHaveBeenCalledTimes(1);
    now = 5_000;
    await p.hasHeadroom();
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('recovers once memory drops back under the threshold', async () => {
    let used = 900;
    const p = probe(async () => info(used, 1000));
    await expect(p.hasHeadroom()).resolves.toBe(false);
    used = 500;
    now = 6_000;
    await expect(p.hasHeadroom()).resolves.toBe(true);
  });
});
