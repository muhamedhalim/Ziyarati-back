import { Injectable } from '@nestjs/common';

export type PresenceStatus = 'ONLINE' | 'BUSY' | 'AWAY' | 'OFFLINE';

export interface AgentPresence {
  userId: string;
  tenantId: string;
  status: PresenceStatus;
  lastActiveAt: string;
  socketCount: number;
}

/**
 * Live Agent Handover presence — tracks which agents are online/busy/away per
 * tenant, for the Agent Inbox's presence badges and "who's available" queue
 * assignment. Keyed by (tenantId, userId); a user can have multiple sockets
 * (multiple tabs) — presence is OFFLINE only once every socket disconnects.
 *
 * SCOPE LIMITATION (documented, not hidden): this is an in-process Map, so it
 * is correct for a single worker/API instance. The Socket.IO layer itself
 * already scales horizontally via the Redis adapter (main.ts), but this
 * presence table does not — a genuinely multi-instance deployment would need
 * to back this with Redis (e.g. a hash keyed by tenant, TTL'd per socket) the
 * same way QueueMonitorService/RedisIoAdapter already do for other state. Not
 * done here to avoid inventing a new Redis schema for a feature that works
 * correctly today at single-instance scale.
 */
@Injectable()
export class AgentPresenceService {
  private readonly byTenant = new Map<string, Map<string, AgentPresence>>();

  connect(tenantId: string, userId: string): AgentPresence {
    const tenantMap = this.mapFor(tenantId);
    const existing = tenantMap.get(userId);
    const presence: AgentPresence = {
      userId,
      tenantId,
      status: 'ONLINE',
      lastActiveAt: new Date().toISOString(),
      socketCount: (existing?.socketCount ?? 0) + 1,
    };
    tenantMap.set(userId, presence);
    return presence;
  }

  /** Returns the resulting presence, or `undefined` if the user has no sockets left. */
  disconnect(tenantId: string, userId: string): AgentPresence | undefined {
    const tenantMap = this.mapFor(tenantId);
    const existing = tenantMap.get(userId);
    if (!existing) return undefined;
    const socketCount = Math.max(0, existing.socketCount - 1);
    if (socketCount === 0) {
      const offline: AgentPresence = { ...existing, status: 'OFFLINE', socketCount: 0, lastActiveAt: new Date().toISOString() };
      tenantMap.set(userId, offline);
      return offline;
    }
    const updated = { ...existing, socketCount };
    tenantMap.set(userId, updated);
    return updated;
  }

  setStatus(tenantId: string, userId: string, status: Exclude<PresenceStatus, 'OFFLINE'>): AgentPresence {
    const tenantMap = this.mapFor(tenantId);
    const existing = tenantMap.get(userId);
    const presence: AgentPresence = {
      userId,
      tenantId,
      status,
      lastActiveAt: new Date().toISOString(),
      socketCount: existing?.socketCount ?? 1,
    };
    tenantMap.set(userId, presence);
    return presence;
  }

  snapshot(tenantId: string): AgentPresence[] {
    return Array.from(this.mapFor(tenantId).values());
  }

  private mapFor(tenantId: string): Map<string, AgentPresence> {
    let m = this.byTenant.get(tenantId);
    if (!m) {
      m = new Map();
      this.byTenant.set(tenantId, m);
    }
    return m;
  }
}
