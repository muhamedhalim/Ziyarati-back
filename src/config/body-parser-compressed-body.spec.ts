import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { gzipSync } from 'node:zlib';
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Server } from 'http';
import type { AddressInfo } from 'node:net';

/**
 * GHSA-27r3-jxmh-p828 — body-parser < 2.4.0 (>= 2.0.0) leaves its decompression stream piped with
 * no error listener, so ONE gzip frame followed by trailing bytes makes the stream emit an error
 * AFTER the response was sent. That surfaces as an uncaught exception and terminates the process,
 * with no authentication and before routing.
 *
 * Two guards live here:
 *  1. a version floor on the body-parser Express actually loads (>= 2.4.0, or >= 1.20.9 on the 1.x line).
 *     Deterministic: it fails on 2.3.0 whatever the Node version or timing.
 *  2. behaviour — a real Nest app with the same `rawBody: true` body-parser configuration as `main.ts`
 *     must keep serving after hostile compressed bodies. The trailing-bytes race itself could not be
 *     triggered on Node 24.18/24.22 with 2.3.0 (a timing/zlib-version dependent crash), so this half
 *     is a safety net for the failure mode, not a proof the old version crashes.
 *
 * The advisory gate (`scripts/check-npm-audit.js`, run by backend-ci.yml `static`) is the third layer.
 */
// A controller (not a route bolted onto the Express instance): Nest installs its body parsers when the
// app initialises, so only Nest-registered routes sit behind them.
@Controller('echo')
class EchoController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return { received: body };
  }
}

@Module({ controllers: [EchoController] })
class EmptyTestModule {}

interface RawResponse {
  status: number;
  body: string;
}

function post(port: number, body: Buffer, headers: Record<string, string>): Promise<RawResponse> {
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

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const atLeast = (version: string, floor: string): boolean => {
  const v = version.split('.').map(Number);
  const f = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== (f[i] ?? 0)) return (v[i] ?? 0) > (f[i] ?? 0);
  }
  return true;
};

describe('body-parser compressed request bodies (GHSA-27r3-jxmh-p828)', () => {
  it('Express loads a patched body-parser (>= 2.4.0 on 2.x, >= 1.20.9 on 1.x)', () => {
    const expressDir = dirname(require.resolve('express/package.json'));
    const pkgPath = require.resolve('body-parser/package.json', { paths: [expressDir] });
    const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const major = Number(version.split('.')[0]);
    expect(atLeast(version, major >= 2 ? '2.4.0' : '1.20.9')).toBe(true);
  });

  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let port: number;
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);

  beforeAll(async () => {
    app = await NestFactory.create(EmptyTestModule, { logger: false, rawBody: true });
    await app.listen(0);
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
  });

  const json = gzipSync(Buffer.from(JSON.stringify({ hello: 'world' })));

  it('still decodes a well-formed gzip JSON body', async () => {
    const res = await post(port, json, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: { hello: 'world' } });
  });

  it('does not raise an uncaught exception for a gzip frame followed by trailing bytes', async () => {
    const poisoned = Buffer.concat([json, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])]);
    // The vulnerable parser answers this request normally and dies afterwards, so a response alone proves nothing.
    await post(port, poisoned, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }).catch(() => undefined);
    await settle(300);
    expect(uncaught).toEqual([]);

    // ...and the server is still alive for the next, unrelated request.
    const after = await post(port, json, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(after.status).toBe(200);
  });

  it('rejects a corrupt gzip body with a client error, not a crash', async () => {
    const res = await post(port, Buffer.from('not gzip at all'), {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    await settle(100);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(uncaught).toEqual([]);
  });

  it('refuses an unsupported Content-Encoding with 415', async () => {
    const res = await post(port, Buffer.from('{}'), { 'Content-Type': 'application/json', 'Content-Encoding': 'br-unknown' });
    expect(res.status).toBe(415);
  });
});
