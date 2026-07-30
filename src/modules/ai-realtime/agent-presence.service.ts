import { Injectable, Logger } from '@nestjs/common';

import { AppRedisService } from '../../queue/app-redis.service';
import { cacheKeyPrefix } from '../../queue/queue.constants';

declare module 'ioredis' {
  interface Redis {
    presenceConnect(
      key: string,
      userId: string,
      lastActiveAt: string,
      ttlSeconds: string,
    ): Promise<string>;
    presenceDisconnect(
      key: string,
      userId: string,
      lastActiveAt: string,
      ttlSeconds: string,
    ): Promise<string | null | false>;
    presenceSetStatus(
      key: string,
      userId: string,
      lastActiveAt: string,
      status: string,
      ttlSeconds: string,
    ): Promise<string>;
  }
}

export type PresenceStatus = 'ONLINE' | 'BUSY' | 'AWAY' | 'OFFLINE';

export interface AgentPresence {
  userId: string;
  tenantId: string;
  status: PresenceStatus;
  lastActiveAt: string;
  socketCount: number;
}

/** Coarse safety net against a crashed process (which never clean-disconnects)
 *  leaving a tenant's presence hash alive forever — refreshed on every write,
 *  so an ACTIVE tenant's hash never expires mid-use. See class docstring for
 *  why this is a bound, not full per-socket TTL tracking. */
const PRESENCE_HASH_TTL_SECONDS = 24 * 3600;

/**
 * Live Agent Handover presence — tracks which agents are online/busy/away per
 * tenant, for the Agent Inbox's presence badges and "who's available" queue
 * assignment. Keyed by (tenantId, userId); a user can have multiple sockets
 * (multiple tabs) — presence is OFFLINE only once every socket disconnects.
 *
 * REDIS-BACKED (gap-closure — see docs/CACHING_QUEUES_AUDIT.md M10): one hash
 * per tenant (`presence:tenant:{tenantId}`), field = userId, value = JSON
 * `AgentPresence`. `connect`/`disconnect`/`setStatus` run as small Lua
 * scripts so the read-increment-write on `socketCount` is atomic across
 * concurrent API replicas — without that, two replicas handling two sockets
 * for the same user connecting at the same instant could both read
 * `socketCount: 0` and both write `socketCount: 1`, undercounting.
 *
 * FAIL-OPEN, not fail-closed: presence is a UI convenience (badges, "who's
 * available"), not a correctness-critical path — a Redis error logs a
 * warning and returns a locally-synthesized best-effort presence (still
 * broadcast to the caller's own room) rather than throwing and breaking the
 * gateway's connect/disconnect handlers.
 *
 * SCOPE LIMITATION (documented, not hidden): the whole per-tenant hash gets a
 * 24h TTL, refreshed on every write, as a coarse bound against a crashed
 * process (one that never fires a clean `disconnect`) leaving phantom
 * "online" entries forever. This is NOT full per-socket TTL/heartbeat
 * tracking (the docstring's originally-sketched design) — that would need
 * either per-field TTLs (Redis 7.4+'s `HEXPIRE`, not safely assumable here;
 * this repo's own dev Redis reports 5.0.14) or a separate heartbeat-refresh
 * loop from the gateway, neither of which existed before this pass and
 * either is a reasonable, separable follow-on. Not a regression from the
 * in-process version either way: a process crash there reset ALL presence
 * to nothing (memory is gone), which is not meaningfully safer than a
 * bounded-stale Redis entry.
 */
@Injectable()
export class AgentPresenceService {
  private readonly logger = new Logger('AgentPresenceService');

  private static readonly CONNECT_SCRIPT = `
    local raw = redis.call('HGET', KEYS[1], ARGV[1])
    local socketCount = 1
    if raw then
      local existing = cjson.decode(raw)
      socketCount = (existing.socketCount or 0) + 1
    end
    local presence = { status = 'ONLINE', lastActiveAt = ARGV[2], socketCount = socketCount }
    local encoded = cjson.encode(presence)
    redis.call('HSET', KEYS[1], ARGV[1], encoded)
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return encoded
  `;

  private static readonly DISCONNECT_SCRIPT = `
    local raw = redis.call('HGET', KEYS[1], ARGV[1])
    if not raw then return false end
    local existing = cjson.decode(raw)
    local socketCount = (existing.socketCount or 1) - 1
    if socketCount < 0 then socketCount = 0 end
    local status = existing.status
    if socketCount == 0 then status = 'OFFLINE' end
    local presence = { status = status, lastActiveAt = ARGV[2], socketCount = socketCount }
    local encoded = cjson.encode(presence)
    redis.call('HSET', KEYS[1], ARGV[1], encoded)
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return encoded
  `;

  private static readonly SET_STATUS_SCRIPT = `
    local raw = redis.call('HGET', KEYS[1], ARGV[1])
    local socketCount = 1
    if raw then
      local existing = cjson.decode(raw)
      socketCount = existing.socketCount or 1
    end
    local presence = { status = ARGV[3], lastActiveAt = ARGV[2], socketCount = socketCount }
    local encoded = cjson.encode(presence)
    redis.call('HSET', KEYS[1], ARGV[1], encoded)
    redis.call('EXPIRE', KEYS[1], ARGV[4])
    return encoded
  `;

  constructor(private readonly appRedis: AppRedisService) {
    this.appRedis.application.defineCommand('presenceConnect', {
      numberOfKeys: 1,
      lua: AgentPresenceService.CONNECT_SCRIPT,
    });
    this.appRedis.application.defineCommand('presenceDisconnect', {
      numberOfKeys: 1,
      lua: AgentPresenceService.DISCONNECT_SCRIPT,
    });
    this.appRedis.application.defineCommand('presenceSetStatus', {
      numberOfKeys: 1,
      lua: AgentPresenceService.SET_STATUS_SCRIPT,
    });
  }

  async connect(tenantId: string, userId: string): Promise<AgentPresence> {
    try {
      const encoded = await this.appRedis.application.presenceConnect(
        this.key(tenantId),
        userId,
        new Date().toISOString(),
        String(PRESENCE_HASH_TTL_SECONDS),
      );
      return this.toPresence(tenantId, userId, encoded);
    } catch (err) {
      this.logger.warn(
        `presence connect failed (best-effort fallback): ${(err as Error)?.message}`,
      );
      return {
        userId,
        tenantId,
        status: 'ONLINE',
        lastActiveAt: new Date().toISOString(),
        socketCount: 1,
      };
    }
  }

  /** Returns the resulting presence, or `undefined` if the user has no sockets left (or on a Redis error). */
  async disconnect(
    tenantId: string,
    userId: string,
  ): Promise<AgentPresence | undefined> {
    try {
      const encoded = await this.appRedis.application.presenceDisconnect(
        this.key(tenantId),
        userId,
        new Date().toISOString(),
        String(PRESENCE_HASH_TTL_SECONDS),
      );
      if (encoded === null || encoded === false) return undefined;
      return this.toPresence(tenantId, userId, encoded as string);
    } catch (err) {
      this.logger.warn(
        `presence disconnect failed (best-effort no-op): ${(err as Error)?.message}`,
      );
      return undefined;
    }
  }

  async setStatus(
    tenantId: string,
    userId: string,
    status: Exclude<PresenceStatus, 'OFFLINE'>,
  ): Promise<AgentPresence> {
    try {
      const encoded = await this.appRedis.application.presenceSetStatus(
        this.key(tenantId),
        userId,
        new Date().toISOString(),
        status,
        String(PRESENCE_HASH_TTL_SECONDS),
      );
      return this.toPresence(tenantId, userId, encoded);
    } catch (err) {
      this.logger.warn(
        `presence setStatus failed (best-effort fallback): ${(err as Error)?.message}`,
      );
      return {
        userId,
        tenantId,
        status,
        lastActiveAt: new Date().toISOString(),
        socketCount: 1,
      };
    }
  }

  async snapshot(tenantId: string): Promise<AgentPresence[]> {
    try {
      const raw = await this.appRedis.application.hgetall(this.key(tenantId));
      return Object.entries(raw).map(([userId, encoded]) =>
        this.toPresence(tenantId, userId, encoded),
      );
    } catch (err) {
      this.logger.warn(
        `presence snapshot failed (returning empty): ${(err as Error)?.message}`,
      );
      return [];
    }
  }

  private key(tenantId: string): string {
    return `${cacheKeyPrefix()}presence:tenant:${tenantId}`;
  }

  private toPresence(
    tenantId: string,
    userId: string,
    encoded: string,
  ): AgentPresence {
    const parsed = JSON.parse(encoded) as Pick<
      AgentPresence,
      'status' | 'lastActiveAt' | 'socketCount'
    >;
    return { userId, tenantId, ...parsed };
  }
}
