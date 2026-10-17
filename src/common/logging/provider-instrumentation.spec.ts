import { Logger } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  classifyError,
  classifyStatus,
  installProviderInstrumentation,
  operationTemplate,
  providerForOrigin,
  setProviderMetricsSink,
} from './provider-instrumentation';
import { StructuredLogger } from './structured-logger';

describe('provider instrumentation — pure helpers', () => {
  it.each([
    ['https://graph.facebook.com', 'meta_graph'],
    ['https://api.tap.company', 'tap'],
    ['https://api.openai.com', 'openai'],
    ['https://myres.openai.azure.com', 'azure_openai'],
    ['https://tenant-webhook.example.com', 'other'],
    ['not a url', 'other'],
  ])('maps %s to %s', (origin, provider) => {
    expect(providerForOrigin(origin)).toBe(provider);
  });

  it('turns a path into a low-cardinality template and drops the query string', () => {
    expect(
      operationTemplate(
        '/v21.0/123456789012345/messages?access_token=EAAG-secret',
      ),
    ).toBe('/v21.0/:id/messages');
    expect(operationTemplate('/v2/charges/chg_TS02A1234567')).toBe(
      '/v2/charges/:id',
    );
    expect(operationTemplate('/v1/chat/completions')).toBe(
      '/v1/chat/completions',
    );
    expect(operationTemplate(undefined)).toBe('/');
  });

  it('classifies statuses and errors', () => {
    expect(classifyStatus(200)).toBe('success');
    expect(classifyStatus(404)).toBe('client_error');
    expect(classifyStatus(429)).toBe('rate_limited');
    expect(classifyStatus(503)).toBe('server_error');
    expect(classifyError({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe('timeout');
    expect(classifyError({ name: 'TimeoutError' })).toBe('timeout');
    expect(classifyError({ code: 'ECONNREFUSED' })).toBe('network_error');
  });
});

describe('provider instrumentation — real fetch through undici diagnostics channels', () => {
  let server: Server;
  let base: string;
  let lines: string[];
  const observed: Array<[string, string]> = [];
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, any>);

  beforeAll(async () => {
    lines = [];
    Logger.overrideLogger(
      new StructuredLogger({
        role: 'api',
        env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' },
        destination: { write: (s: string) => void lines.push(s) },
      }),
    );
    setProviderMetricsSink({
      observeProviderRequest: (p, o) => void observed.push([p, o]),
    });
    installProviderInstrumentation();
    server = createServer((req, res) => {
      const status = Number(
        new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? 200,
      );
      res.writeHead(status).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setProviderMetricsSink(undefined);
    Logger.overrideLogger(['error']);
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    lines.length = 0;
    observed.length = 0;
  });

  it('records a success at debug, without host, path or query for an unknown target', async () => {
    await (
      await fetch(
        `${base}/hooks/123?access_token=SECRET_TOKEN_VALUE&status=200`,
      )
    ).text();
    expect(observed).toEqual([['other', 'success']]);
    const [r] = records();
    expect(r).toMatchObject({
      event: 'provider.request.completed',
      level: 'debug',
      provider: 'other',
      status: 200,
    });
    expect(r.operation).toBeUndefined();
    expect(lines.join('')).not.toContain('SECRET_TOKEN_VALUE');
    expect(lines.join('')).not.toContain('127.0.0.1');
  });

  it('records a 5xx / 429 at warn', async () => {
    await (await fetch(`${base}/x?status=503`)).text();
    await (await fetch(`${base}/x?status=429`)).text();
    expect(observed).toEqual([
      ['other', 'server_error'],
      ['other', 'rate_limited'],
    ]);
    expect(records().map((r) => [r.level, r.event, r.outcome])).toEqual([
      ['warn', 'provider.request.failed', 'server_error'],
      ['warn', 'provider.request.failed', 'rate_limited'],
    ]);
  });

  it('keeps a 4xx at debug (the caller owns its business meaning)', async () => {
    await (await fetch(`${base}/x?status=404`)).text();
    expect(records()[0]).toMatchObject({
      level: 'debug',
      outcome: 'client_error',
    });
  });

  it('records a connection failure as network_error', async () => {
    // A free, closed port (not one on the Fetch spec's blocked-port list, which
    // fetch refuses before dispatching anything).
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));

    await expect(
      fetch(`http://127.0.0.1:${port}/nothing-listens-here`),
    ).rejects.toThrow();
    expect(observed).toEqual([['other', 'network_error']]);
    expect(records()[0]).toMatchObject({
      level: 'warn',
      outcome: 'network_error',
      error_code: 'ECONNREFUSED',
    });
  });
});
