/**
 * Unit-level: exercises the PUBLIC contract (connect/disconnect/setStatus/
 * snapshot) against a fake Redis that mirrors each Lua script's logic in JS
 * (a real Lua interpreter isn't available in Jest). The actual Lua scripts
 * are separately verified against a real local Redis instance — see the
 * M10 write-up in docs/CACHING_QUEUES_AUDIT.md for that live verification.
 */
class FakeRedisPresence {
  hashes = new Map<string, Map<string, string>>();
  commandFailure: Error | null = null;

  defineCommand(): void {
    // no-op — this fake directly implements presenceConnect/etc. below
  }

  private hashFor(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async presenceConnect(
    key: string,
    userId: string,
    lastActiveAt: string,
  ): Promise<string> {
    if (this.commandFailure) throw this.commandFailure;
    const h = this.hashFor(key);
    const existing = h.get(userId);
    const socketCount = existing
      ? (JSON.parse(existing).socketCount ?? 0) + 1
      : 1;
    const encoded = JSON.stringify({
      status: 'ONLINE',
      lastActiveAt,
      socketCount,
    });
    h.set(userId, encoded);
    return encoded;
  }

  async presenceDisconnect(
    key: string,
    userId: string,
    lastActiveAt: string,
  ): Promise<string | false> {
    if (this.commandFailure) throw this.commandFailure;
    const h = this.hashFor(key);
    const existing = h.get(userId);
    if (!existing) return false;
    const parsed = JSON.parse(existing);
    const socketCount = Math.max(0, (parsed.socketCount ?? 1) - 1);
    const status = socketCount === 0 ? 'OFFLINE' : parsed.status;
    const encoded = JSON.stringify({ status, lastActiveAt, socketCount });
    h.set(userId, encoded);
    return encoded;
  }

  async presenceSetStatus(
    key: string,
    userId: string,
    lastActiveAt: string,
    status: string,
  ): Promise<string> {
    if (this.commandFailure) throw this.commandFailure;
    const h = this.hashFor(key);
    const existing = h.get(userId);
    const socketCount = existing ? (JSON.parse(existing).socketCount ?? 1) : 1;
    const encoded = JSON.stringify({ status, lastActiveAt, socketCount });
    h.set(userId, encoded);
    return encoded;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (this.commandFailure) throw this.commandFailure;
    return Object.fromEntries(this.hashFor(key));
  }
}

import { AgentPresenceService } from './agent-presence.service';
import { AppRedisService } from '../../queue/app-redis.service';

describe('AgentPresenceService (Redis-backed, M10)', () => {
  let redis: FakeRedisPresence;
  let service: AgentPresenceService;

  beforeEach(() => {
    redis = new FakeRedisPresence();
    const appRedis = { application: redis } as unknown as AppRedisService;
    service = new AgentPresenceService(appRedis);
  });

  it('connect() sets ONLINE with socketCount 1 for a fresh user', async () => {
    const p = await service.connect('t1', 'u1');
    expect(p).toMatchObject({
      tenantId: 't1',
      userId: 'u1',
      status: 'ONLINE',
      socketCount: 1,
    });
  });

  it('a second connect() from another tab increments socketCount without changing status', async () => {
    await service.connect('t1', 'u1');
    const p = await service.connect('t1', 'u1');
    expect(p.socketCount).toBe(2);
    expect(p.status).toBe('ONLINE');
  });

  it('disconnect() decrements socketCount and only goes OFFLINE at zero', async () => {
    await service.connect('t1', 'u1');
    await service.connect('t1', 'u1'); // 2 sockets
    const afterOne = await service.disconnect('t1', 'u1');
    expect(afterOne).toMatchObject({ socketCount: 1, status: 'ONLINE' });
    const afterBoth = await service.disconnect('t1', 'u1');
    expect(afterBoth).toMatchObject({ socketCount: 0, status: 'OFFLINE' });
  });

  it('disconnect() for a user with no presence entry returns undefined', async () => {
    await expect(
      service.disconnect('t1', 'never-connected'),
    ).resolves.toBeUndefined();
  });

  it('setStatus() preserves socketCount while changing status', async () => {
    await service.connect('t1', 'u1');
    await service.connect('t1', 'u1'); // socketCount 2
    const p = await service.setStatus('t1', 'u1', 'BUSY');
    expect(p).toMatchObject({ status: 'BUSY', socketCount: 2 });
  });

  it('snapshot() returns every tracked user for the tenant, correctly shaped', async () => {
    await service.connect('t1', 'u1');
    await service.connect('t1', 'u2');
    const snap = await service.snapshot('t1');
    expect(snap).toHaveLength(2);
    expect(snap.map((p) => p.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('tenants are isolated from each other', async () => {
    await service.connect('t1', 'u1');
    await service.connect('t2', 'u2');
    expect(await service.snapshot('t1')).toHaveLength(1);
    expect(await service.snapshot('t2')).toHaveLength(1);
  });

  describe('fail-open on a Redis error (presence is a UI convenience, not correctness-critical)', () => {
    beforeEach(() => {
      redis.commandFailure = new Error('redis unavailable');
    });

    it('connect() falls back to a best-effort local presence instead of throwing', async () => {
      const p = await service.connect('t1', 'u1');
      expect(p).toMatchObject({
        tenantId: 't1',
        userId: 'u1',
        status: 'ONLINE',
      });
    });

    it('disconnect() fails open to undefined instead of throwing', async () => {
      await expect(service.disconnect('t1', 'u1')).resolves.toBeUndefined();
    });

    it('setStatus() falls back to a best-effort local presence instead of throwing', async () => {
      const p = await service.setStatus('t1', 'u1', 'AWAY');
      expect(p).toMatchObject({ status: 'AWAY' });
    });

    it('snapshot() fails open to an empty array instead of throwing', async () => {
      await expect(service.snapshot('t1')).resolves.toEqual([]);
    });
  });
});
