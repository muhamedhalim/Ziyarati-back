import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as zlib from 'node:zlib';
import * as http from 'node:http';
import type { Server } from 'http';
import type { AddressInfo } from 'node:net';

import { rejectBrotliRequestBody } from './brotli-request-body.middleware';

/**
 * CVE-2026-111497 (Node.js 2026-10-21 security release): out-of-bounds write in the Brotli decoder.
 * This is the APPLICATION defence — no hostile Brotli stream is sent (that is the runtime's job,
 * fixed in Node >= 24.22.1); the spec proves only that a `br` request body never reaches the decoder.
 * (node:zlib's exports are read-only, so the decoder cannot be spied on. The proof is the status:
 * body-parser 2.x SUPPORTS `br` — the control case decodes it — so it can never answer 415 for it;
 * a 415 for `br` can only come from the guard, before body-parser read a byte.)
 * Same Nest bootstrap shape as main.ts: `rawBody: true`, middleware registered before init.
 */
@Controller('echo')
class EchoController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return { received: body };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

function post(port: number, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/echo', method: 'POST', headers: { ...headers, 'Content-Length': body.length } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function start(withGuard: boolean) {
  const app = await NestFactory.create(EchoModule, { logger: false, rawBody: true });
  if (withGuard) app.use(rejectBrotliRequestBody);
  await app.listen(0);
  return { app, port: ((app.getHttpServer() as Server).address() as AddressInfo).port };
}

const payload = Buffer.from(JSON.stringify({ hello: 'world' }));
const json = { 'Content-Type': 'application/json' };

describe('rejectBrotliRequestBody (CVE-2026-111497 application defence)', () => {
  let guarded: Awaited<ReturnType<typeof start>>;
  let unguarded: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    guarded = await start(true);
    unguarded = await start(false);
  });

  afterAll(async () => {
    await guarded.app.close();
    await unguarded.app.close();
  });

  it('control: without the guard, body-parser feeds a `br` body to the Brotli decoder (the exposure)', async () => {
    const res = await post(unguarded.port, zlib.brotliCompressSync(payload), { ...json, 'Content-Encoding': 'br' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: { hello: 'world' } });
  });

  it.each(['br', 'BR', ' br ', 'gzip, br', 'br, gzip'])(
    'refuses Content-Encoding "%s" with 415 and never starts the Brotli decoder',
    async (encoding) => {
      const res = await post(guarded.port, zlib.brotliCompressSync(payload), { ...json, 'Content-Encoding': encoding });
      expect(res.status).toBe(415);
      expect(res.body).not.toContain('world');
    },
  );

  it('still decodes gzip request bodies', async () => {
    const res = await post(guarded.port, zlib.gzipSync(payload), { ...json, 'Content-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: { hello: 'world' } });
  });

  it('still accepts uncompressed request bodies', async () => {
    const res = await post(guarded.port, payload, json);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: { hello: 'world' } });
  });
});
