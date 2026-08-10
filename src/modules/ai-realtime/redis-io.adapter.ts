import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter backed by Redis pub/sub (`@socket.io/redis-adapter`) so the
 * realtime gateway scales horizontally — an event emitted on one API instance
 * reaches sockets connected to every other instance. Reuses the SAME `REDIS_URL`
 * as the BullMQ subsystem. Soft: if Redis can't be reached (or no URL), it logs
 * and falls back to the default in-memory adapter, so the app still boots.
 *
 * PERF-INFRA-003 Stage B (production-readiness validation pass) — transport
 * restriction under process-level clustering. The Redis adapter above solves
 * cross-worker EVENT delivery (broadcast/emit), but not cross-worker SESSION
 * affinity: Engine.io's HTTP long-polling transport keeps its per-session
 * handshake state in the ONE worker process that accepted the original
 * handshake, and every subsequent poll must land back on that exact worker.
 * Node's `cluster` module (`cluster-bootstrap.ts`) has no such affinity — each
 * new HTTP request is distributed to an arbitrary worker — so a polling
 * client's second request can land on a worker that has never heard of its
 * session and reject it (measured: `infra003-crossprocess-transport-probe.js`).
 * A persistent WebSocket connection has no such problem: once the upgrade
 * handshake completes on worker W, the OS-level TCP socket is already owned by
 * W and every subsequent frame flows over that same connection — no further
 * HTTP dispatch/routing occurs, so no worker affinity is required.
 *
 * Rather than introduce sticky-session routing (Railway's ingress does not
 * provide it, and this project makes a point of never assuming external
 * infrastructure it hasn't verified — see cluster-bootstrap.ts), the smaller
 * and strictly safer fix is to stop offering the transport that needs
 * affinity, but ONLY once clustering is actually active: single-process
 * deployments (the default, `API_CLUSTER_WORKERS<=1`) keep full
 * polling+websocket compatibility, byte-identical to before this change.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger('RedisIoAdapter');
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  /** Mirrors cluster-bootstrap.ts's own `API_CLUSTER_WORKERS` parsing exactly. */
  private isClustered(): boolean {
    const requested = Number(process.env.API_CLUSTER_WORKERS ?? 1);
    const numWorkers = Number.isFinite(requested)
      ? Math.max(1, Math.floor(requested))
      : 1;
    return numWorkers > 1;
  }

  async connectToRedis(): Promise<void> {
    const config = this.app.get(ConfigService);
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn('REDIS_URL not set — realtime gateway uses the in-memory adapter (single instance).');
      return;
    }
    try {
      const pubClient = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, connectionName: 'socketio:pub' });
      const subClient = pubClient.duplicate({ connectionName: 'socketio:sub' });
      // An ioredis client with no 'error' listener throws an unhandled 'error'
      // event on a later socket error (not just at connect time), which can
      // crash the whole process — these were previously unguarded.
      pubClient.on('error', (err) => this.logger.warn(`Redis pub client error (non-fatal): ${err.message}`));
      subClient.on('error', (err) => this.logger.warn(`Redis sub client error (non-fatal): ${err.message}`));
      await pubClient.connect();
      await subClient.connect();
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log('Realtime gateway Redis adapter connected (horizontal scaling enabled).');
    } catch (err) {
      this.logger.warn(`Redis adapter unavailable (${(err as Error)?.message}) — in-memory fallback.`);
    }
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    let effectiveOptions = options;
    if (this.isClustered()) {
      effectiveOptions = {
        ...options,
        transports: ['websocket'],
      } as ServerOptions;
      this.logger.warn(
        'API_CLUSTER_WORKERS > 1 — restricting Socket.IO to the websocket ' +
          'transport only (HTTP long-polling requires per-worker session ' +
          'affinity this deployment does not provide). A client whose ' +
          'websocket upgrade genuinely fails gets a clean, immediate ' +
          'connection error instead of a silent mid-session break.',
      );
    }
    const server = super.createIOServer(port, effectiveOptions);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
