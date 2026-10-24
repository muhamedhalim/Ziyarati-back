import { BadRequestException, Controller, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Server } from 'http';
import type { AddressInfo } from 'node:net';

/**
 * GHSA-q7qp-rjg7-q26m — multer >= 2.0.0 < 2.5.0: when a request is torn down (client abort, or a limit
 * trips) while an ASYNCHRONOUS `fileFilter` is still pending, multer detaches every busboy listener —
 * including the `error` one — and a late busboy error then has nobody to catch it, so it surfaces as an
 * uncaught exception that kills the process. No authentication is needed to reach it on any route that
 * runs the interceptor before its guard.
 *
 * `@nestjs/platform-express` pins multer EXACTLY (11.x and 12.x both pin 2.4.0), so the fix is the scoped
 * `overrides` entry in package.json; this suite is what keeps it from being dropped by a later
 * `npm install`/Nest bump. The repo's own upload routes use no custom `fileFilter`, so the advisory path
 * is not reachable from application code today — the guard exists for the day one is added.
 *
 * Two layers, mirroring body-parser-compressed-body.spec.ts:
 *  1. a version floor on the multer Nest actually loads (deterministic);
 *  2. behaviour — a real Nest app, a real `FileInterceptor` with a slow async filter, requests that
 *     are torn down mid-filter; the process must not see an uncaughtException and must keep serving.
 *     Honest limit: with multer 2.4.0 these scenarios (hang-up, parts/fileSize limit, malformed or
 *     truncated trailing parts — also probed outside Nest on Node 24) did NOT crash the process, so this
 *     half is a safety net for the failure mode rather than proof the old version dies. Only layer 1 fails
 *     on 2.4.0.
 */
const FILTER_DELAY_MS = 150;

@Controller('up')
class UploadController {
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024, parts: 3, fields: 2 },
      // Deliberately ASYNC: this is the shape the advisory is about.
      fileFilter: (_req, file, cb) => {
        setTimeout(() => {
          if (file.originalname.endsWith('.exe')) return cb(new BadRequestException('type not allowed'), false);
          cb(null, true);
        }, FILTER_DELAY_MS);
      },
    }),
  )
  upload(@UploadedFile() file?: { originalname: string; size: number }) {
    return { name: file?.originalname ?? null, size: file?.size ?? 0 };
  }
}

@Module({ controllers: [UploadController] })
class UploadTestModule {}

const BOUNDARY = '----ziyaratiBoundary';

const filePart = (name: string, payload: string) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
  `Content-Type: application/octet-stream\r\n\r\n${payload}\r\n`;
const fieldPart = (name: string, value: string) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const closing = `--${BOUNDARY}--\r\n`;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const atLeast = (version: string, floor: string): boolean => {
  const v = version.split('.').map(Number);
  const f = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== (f[i] ?? 0)) return (v[i] ?? 0) > (f[i] ?? 0);
  }
  return true;
};

interface RawResponse {
  status: number;
  body: string;
}

function send(port: number, body: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/up',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
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

/** Sends the head of a multipart request, then kills the socket while the filter is still pending. */
function abortMidFilter(port: number, head: string, afterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/up',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        // Promise more than we send so the server is still waiting for the body when we hang up.
        'Content-Length': Buffer.byteLength(head) + 4096,
      },
    });
    req.on('error', () => undefined);
    req.on('close', () => resolve());
    req.write(head);
    setTimeout(() => req.destroy(), afterMs);
  });
}

describe('multer async fileFilter after request teardown (GHSA-q7qp-rjg7-q26m)', () => {
  it('Nest loads a patched multer (>= 2.5.0)', () => {
    const nestDir = dirname(require.resolve('@nestjs/platform-express/package.json'));
    const pkgPath = require.resolve('multer/package.json', { paths: [nestDir] });
    const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(atLeast(version, '2.5.0')).toBe(true);
  });

  it('package.json keeps the scoped override that lifts the exact multer pin', () => {
    const pkg = JSON.parse(readFileSync(require.resolve('../../package.json'), 'utf8')) as {
      overrides?: Record<string, Record<string, string> | string>;
    };
    const scoped = pkg.overrides?.['@nestjs/platform-express'];
    expect(typeof scoped).toBe('object');
    expect(atLeast((scoped as Record<string, string>).multer.replace(/^[^\d]*/, ''), '2.5.0')).toBe(true);
  });

  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let port: number;
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  const onUnhandled = (err: unknown) => unhandled.push(err);

  beforeAll(async () => {
    app = await NestFactory.create(UploadTestModule, { logger: false });
    await app.listen(0);
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    uncaught.length = 0;
    unhandled.length = 0;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  });

  const expectAliveAndClean = async () => {
    // Outlive the pending filter timer so a late callback has fired.
    await settle(FILTER_DELAY_MS * 3);
    expect(uncaught).toEqual([]);
    expect(unhandled).toEqual([]);
    const after = await send(port, filePart('ok.txt', 'hello') + closing);
    expect(after.status).toBe(201);
    expect(JSON.parse(after.body)).toEqual({ name: 'ok.txt', size: 5 });
  };

  it('accepts a legitimate upload through an async filter', async () => {
    const res = await send(port, filePart('doc.txt', 'hello world') + closing);
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ name: 'doc.txt', size: 11 });
  });

  it('turns an async filter rejection into a client error', async () => {
    const res = await send(port, filePart('evil.exe', 'MZ') + closing);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('survives the client hanging up while the async filter is pending', async () => {
    await abortMidFilter(port, filePart('slow.txt', 'partial'), 30);
    await expectAliveAndClean();
  });

  it('survives a parts limit tripping while the async filter is pending', async () => {
    // parts: 3 → the file plus three fields is one too many; the limit fires while the filter timer runs.
    const body =
      filePart('slow.txt', 'hello') + fieldPart('a', '1') + fieldPart('b', '2') + fieldPart('c', '3') + closing;
    const res = await send(port, body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expectAliveAndClean();
  });

  it('survives an over-sized file tripping fileSize while the async filter is pending', async () => {
    const res = await send(port, filePart('big.txt', 'x'.repeat(4096)) + closing);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expectAliveAndClean();
  });

  it('survives a truncated multipart body followed by a hang-up', async () => {
    // No closing boundary and a short socket: busboy raises "Unexpected end of form" after teardown.
    await abortMidFilter(port, filePart('slow.txt', 'abc') + fieldPart('a', '1'), FILTER_DELAY_MS + 40);
    await expectAliveAndClean();
  });
});
