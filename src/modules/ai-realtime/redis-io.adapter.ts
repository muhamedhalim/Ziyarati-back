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
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger('RedisIoAdapter');
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
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
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
