import { DistributedLockService } from './distributed-lock.service';
import { AppRedisService } from './app-redis.service';

describe('DistributedLockService', () => {
  const makeRedis = () => ({
    application: {
      set: jest.fn(),
      eval: jest.fn(),
    },
  });

  it('acquires the lock (SET NX) and returns an ownership token', async () => {
    const redis = makeRedis();
    redis.application.set.mockResolvedValue('OK');
    const lock = new DistributedLockService(redis as unknown as AppRedisService);

    const token = await lock.acquire('lock:x', 90_000);

    expect(token).toEqual(expect.any(String));
    expect(redis.application.set).toHaveBeenCalledWith('lock:x', token, 'PX', 90_000, 'NX');
  });

  it('returns null when the lock is already held (SET NX returns null)', async () => {
    const redis = makeRedis();
    redis.application.set.mockResolvedValue(null);
    const lock = new DistributedLockService(redis as unknown as AppRedisService);

    const token = await lock.acquire('lock:x', 90_000);

    expect(token).toBeNull();
  });

  it('fails closed to "not acquired" (never throws) when Redis errors', async () => {
    const redis = makeRedis();
    redis.application.set.mockRejectedValue(new Error('ECONNRESET'));
    const lock = new DistributedLockService(redis as unknown as AppRedisService);

    await expect(lock.acquire('lock:x', 90_000)).resolves.toBeNull();
  });

  it('releases via the compare-and-delete Lua script with the key, count, key and token', async () => {
    const redis = makeRedis();
    redis.application.eval.mockResolvedValue(1);
    const lock = new DistributedLockService(redis as unknown as AppRedisService);

    await lock.release('lock:x', 'token-123');

    expect(redis.application.eval).toHaveBeenCalledWith(expect.stringContaining('redis.call'), 1, 'lock:x', 'token-123');
  });

  it('release never throws even if Redis errors (self-expires via TTL instead)', async () => {
    const redis = makeRedis();
    redis.application.eval.mockRejectedValue(new Error('ECONNRESET'));
    const lock = new DistributedLockService(redis as unknown as AppRedisService);

    await expect(lock.release('lock:x', 'token-123')).resolves.toBeUndefined();
  });
});
