import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { performGenericRestRequest } from './generic-rest-http-client';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('performGenericRestRequest', () => {
  it('returns ok:true with the status + body for a 2xx response', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hello":"world"}');
    });
    try {
      const res = await performGenericRestRequest({
        method: 'GET',
        url: server.url,
        headers: {},
        timeoutMs: 2000,
        maxResponseBytes: 1024,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.bodyText).toBe('{"hello":"world"}');
    } finally {
      await server.close();
    }
  });

  it('returns ok:false for a non-2xx status, transient for 5xx', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(503);
      res.end('down');
    });
    try {
      const res = await performGenericRestRequest({
        method: 'GET',
        url: server.url,
        headers: {},
        timeoutMs: 2000,
        maxResponseBytes: 1024,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(res.transient).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('treats a 4xx as permanent (not transient)', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      const res = await performGenericRestRequest({
        method: 'GET',
        url: server.url,
        headers: {},
        timeoutMs: 2000,
        maxResponseBytes: 1024,
      });
      expect(res.ok).toBe(false);
      expect(res.transient).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('never follows a redirect — a 3xx is reported as a plain non-ok result', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    try {
      const res = await performGenericRestRequest({
        method: 'GET',
        url: server.url,
        headers: {},
        timeoutMs: 2000,
        maxResponseBytes: 1024,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(302);
    } finally {
      await server.close();
    }
  });

  it('enforces the timeout against a slow/hanging server', async () => {
    const server = await startServer(() => {
      // Never respond.
    });
    try {
      const res = await performGenericRestRequest({
        method: 'GET',
        url: server.url,
        headers: {},
        timeoutMs: 150,
        maxResponseBytes: 1024,
      });
      expect(res.ok).toBe(false);
      expect(res.transient).toBe(true);
    } finally {
      await server.close();
    }
  }, 5000);

  it('stops reading once the response exceeds the size cap, rather than buffering an unbounded stream', async () => {
    const CHUNK = 'x'.repeat(1000);
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      let sent = 0;
      // Small delays force each write onto its own TCP segment/'data' event,
      // unlike a single synchronous `res.end(hugeString)` which loopback can
      // coalesce into one read — this exercises the cap's actual job: never
      // let a slow/malicious streaming response grow the buffer unbounded.
      const timer = setInterval(() => {
        if (sent >= 50) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(CHUNK);
        sent += 1;
      }, 2);
    });
    try {
      const res = await performGenericRestRequest({
        method: 'GET',
        url: server.url,
        headers: {},
        timeoutMs: 2000,
        maxResponseBytes: 2000,
      });
      // 50 * 1000 = 50,000 bytes would be buffered with no cap; the cap must
      // have stopped it well short of that.
      expect(res.bodyText!.length).toBeLessThan(10_000);
    } finally {
      await server.close();
    }
  });

  it('sends a request body and custom headers for POST', async () => {
    let seenBody = '';
    let seenHeader: string | undefined;
    const server = await startServer((req, res) => {
      seenHeader = req.headers['x-custom'] as string | undefined;
      req.on('data', (c) => (seenBody += c));
      req.on('end', () => {
        res.writeHead(200);
        res.end();
      });
    });
    try {
      await performGenericRestRequest({
        method: 'POST',
        url: server.url,
        headers: { 'X-Custom': 'abc' },
        body: JSON.stringify({ a: 1 }),
        timeoutMs: 2000,
        maxResponseBytes: 1024,
      });
      expect(seenBody).toBe('{"a":1}');
      expect(seenHeader).toBe('abc');
    } finally {
      await server.close();
    }
  });

  it('returns a safe, non-revealing error for a blocked target rather than a raw exception', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await performGenericRestRequest({
        method: 'GET',
        url: 'https://10.0.0.5/internal',
        headers: {},
        timeoutMs: 2000,
        maxResponseBytes: 1024,
      });
      expect(res.ok).toBe(false);
      expect(res.transient).toBe(false);
      expect(res.error).toMatch(/Blocked/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
