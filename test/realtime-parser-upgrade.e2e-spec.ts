/**
 * ZT-004a regression coverage — the `socket.io-parser` memory-exhaustion
 * advisory (GHSA-2m8v-j782-fhvr, affected `>=4.0.0 <4.2.7`).
 *
 * Unlike `ai-guest-isolation.e2e-spec.ts` (which drives `AiRealtimeGateway`
 * handlers directly through a `FakeSocket` double — deliberately NOT
 * exercising Socket.IO's own transport, per that file's own docstring), this
 * suite opens a REAL `socket.io-client` connection over a REAL listening HTTP
 * server. That is the only kind of test that actually exercises
 * `socket.io-parser` (the wire-protocol packet encoder/decoder this finding
 * is about) — a fake socket never touches it.
 *
 * `socket.io-client` is not a declared dependency of this backend; it is
 * already present in `node_modules` (hoisted from `artillery`'s own bundled
 * copy, itself pinned to `^4.8.3` — the same major/minor line this backend's
 * server uses). Requiring it here needs no `package.json` or
 * `package-lock.json` change, keeping the ZT-004a diff confined to exactly
 * the one lockfile line the task requires.
 */
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createE2eApp, type E2eApp } from './utils/whatsapp-e2e-app';
import { AI_EVENT } from '../src/modules/ai-realtime/ai-events.constants';

describe('ZT-004a — realtime packet-parser upgrade (socket.io-parser >= 4.2.7)', () => {
  let e2e: E2eApp;
  let baseUrl: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    await e2e.app.listen(0);
    const address = e2e.app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await e2e.app.close();
  });

  it('resolved socket.io-parser is outside the advisory range (>= 4.2.7), and socket.io itself is unchanged (4.8.3)', () => {
    // `require('<pkg>/package.json')` is blocked by these packages' own
    // `exports` map (it lists only `.`, not `./package.json`), so the
    // installed version is read straight off disk instead — this is the
    // exact file `npm ls`/`npm install` themselves resolve from.
    const readInstalledVersion = (pkg: string): string =>
      JSON.parse(
        readFileSync(
          join(__dirname, '..', 'node_modules', pkg, 'package.json'),
          'utf8',
        ),
      ).version as string;

    const parserVersion = readInstalledVersion('socket.io-parser');
    const engineVersion = readInstalledVersion('socket.io');

    const [major, minor, patch] = parserVersion.split('.').map(Number);
    const outsideAdvisoryRange =
      major > 4 ||
      (major === 4 && minor > 2) ||
      (major === 4 && minor === 2 && patch >= 7);
    expect(outsideAdvisoryRange).toBe(true);
    expect(engineVersion).toBe('4.8.3');
  });

  it('an authenticated /ai namespace session connects, exchanges a message and disconnects cleanly', async () => {
    // Mint a real guest session exactly as an anonymous visitor would — the
    // same zero-privilege path the finding's threat model describes.
    const sessionRes = await request(e2e.app.getHttpServer())
      .post('/api/v1/public/guest/session')
      .send({})
      .expect(200);
    const cookies = sessionRes.headers['set-cookie'] as unknown as string[];
    const guestCookie = cookies.find((c) => c.startsWith('guest_token='));
    if (!guestCookie) throw new Error('guest_token cookie was not issued');
    const guestToken = decodeURIComponent(
      guestCookie.split(';')[0].split('=').slice(1).join('='),
    );

    const client: ClientSocket = ioClient(`${baseUrl}/ai`, {
      auth: { token: guestToken },
      transports: ['websocket'],
      forceNew: true,
    });

    try {
      // ── connect ──────────────────────────────────────────────────────
      const connected = await new Promise<{ userId: string; tenantId: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('timed out waiting for ai:connected')),
            10_000,
          );
          client.on(
            AI_EVENT.CONNECTED,
            (payload: { userId: string; tenantId: string }) => {
              clearTimeout(timer);
              resolve(payload);
            },
          );
          client.on('connect_error', (err: Error) => {
            clearTimeout(timer);
            reject(err);
          });
        },
      );
      expect(connected.userId).toBeTruthy();
      expect(connected.tenantId).toBeTruthy();
      expect(client.connected).toBe(true);

      // ── exchange a message ──────────────────────────────────────────
      // A real client -> server packet, server-side handling, and a real
      // server -> client ack packet — round-tripping through the exact
      // parser this finding is about.
      const snapshot = await new Promise<unknown[]>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error('timed out waiting for presence snapshot ack')),
          10_000,
        );
        client.emit(AI_EVENT.PRESENCE_SNAPSHOT, (ack: unknown[]) => {
          clearTimeout(timer);
          resolve(ack);
        });
      });
      expect(Array.isArray(snapshot)).toBe(true);

      // ── disconnect ───────────────────────────────────────────────────
      const disconnectReason = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for disconnect')),
          10_000,
        );
        client.on('disconnect', (reason: string) => {
          clearTimeout(timer);
          resolve(reason);
        });
        client.disconnect();
      });
      expect(disconnectReason).toBe('io client disconnect');
      expect(client.connected).toBe(false);
    } finally {
      if (client.connected) client.disconnect();
    }
  }, 30_000);
});
