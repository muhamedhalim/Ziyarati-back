import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { GenericRestAdapter } from './generic-rest.adapter';
import { CONNECTION_AUTH_TYPE } from '../integration-platform.constants';
import { ProviderContext } from './provider.types';

/**
 * These tests run a REAL local HTTP server on 127.0.0.1 and drive the adapter
 * against it. `NODE_ENV=test` (Jest's default) makes `integration-url-guard`
 * permissive of loopback/private hosts, so this exercises the full request
 * path (auth injection, pagination, cursor handling) without mocking the
 * transport — only the SSRF *policy* itself is covered separately, with
 * mocked DNS, in integration-url-guard.spec.ts.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function ctx(over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'c1',
    tenantId: 't1',
    authType: CONNECTION_AUTH_TYPE.NONE,
    credential: null,
    config: null,
    ...over,
  };
}

describe('GenericRestAdapter — healthCheck', () => {
  it('reports ok for any response status other than 401/403', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    try {
      const adapter = new GenericRestAdapter();
      const result = await adapter.healthCheck(ctx({ config: { baseUrl: server.url } }));
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await server.close();
    }
  });

  it('reports a specific failure for a 401/403 (reachable, auth rejected)', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    try {
      const adapter = new GenericRestAdapter();
      const result = await adapter.healthCheck(
        ctx({ authType: CONNECTION_AUTH_TYPE.SECRET, credential: 'bad-token', config: { baseUrl: server.url } }),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/authentication was rejected/);
    } finally {
      await server.close();
    }
  });

  it('fails fast without a baseUrl configured (no network attempted)', async () => {
    const adapter = new GenericRestAdapter();
    const result = await adapter.healthCheck(ctx({ config: null }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/base URL/);
  });

  it('sends the API key on the configured header name when auth_type is api_key', async () => {
    let seenHeader: string | undefined;
    const server = await startServer((req, res) => {
      seenHeader = req.headers['x-api-key'] as string | undefined;
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new GenericRestAdapter();
      await adapter.healthCheck(
        ctx({
          authType: CONNECTION_AUTH_TYPE.API_KEY,
          credential: 'secret-key-123',
          config: { baseUrl: server.url, apiKey: { location: 'header', name: 'X-Api-Key' } },
        }),
      );
      expect(seenHeader).toBe('secret-key-123');
    } finally {
      await server.close();
    }
  });

  it('sends the API key as a query param when location is query', async () => {
    let seenQuery: string | null = null;
    const server = await startServer((req, res) => {
      seenQuery = new URL(req.url ?? '', 'http://x').searchParams.get('api_key');
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new GenericRestAdapter();
      await adapter.healthCheck(
        ctx({
          authType: CONNECTION_AUTH_TYPE.API_KEY,
          credential: 'qk-1',
          config: { baseUrl: server.url, apiKey: { location: 'query', name: 'api_key' } },
        }),
      );
      expect(seenQuery).toBe('qk-1');
    } finally {
      await server.close();
    }
  });

  it('sends a Basic Auth header built from config.basic.username + the credential password', async () => {
    let seenAuth: string | undefined;
    const server = await startServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new GenericRestAdapter();
      await adapter.healthCheck(
        ctx({
          authType: CONNECTION_AUTH_TYPE.BASIC,
          credential: 'p@ssw0rd',
          config: { baseUrl: server.url, basic: { username: 'svc-user' } },
        }),
      );
      expect(seenAuth).toBe(`Basic ${Buffer.from('svc-user:p@ssw0rd').toString('base64')}`);
    } finally {
      await server.close();
    }
  });

  it('sends a Bearer token for the "secret" auth type', async () => {
    let seenAuth: string | undefined;
    const server = await startServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new GenericRestAdapter();
      await adapter.healthCheck(
        ctx({ authType: CONNECTION_AUTH_TYPE.SECRET, credential: 'tok-abc', config: { baseUrl: server.url } }),
      );
      expect(seenAuth).toBe('Bearer tok-abc');
    } finally {
      await server.close();
    }
  });

  it('sends configured custom headers', async () => {
    let seenHeader: string | undefined;
    const server = await startServer((req, res) => {
      seenHeader = req.headers['x-tenant-id'] as string | undefined;
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new GenericRestAdapter();
      await adapter.healthCheck(
        ctx({ config: { baseUrl: server.url, advanced: { headers: { 'X-Tenant-Id': 'tenant-42' } } } }),
      );
      expect(seenHeader).toBe('tenant-42');
    } finally {
      await server.close();
    }
  });
});

describe('GenericRestAdapter — pullChanges', () => {
  it('is an honest no-op when no endpoint is configured for the resource', async () => {
    const adapter = new GenericRestAdapter();
    const page = await adapter.pullChanges(ctx({ config: { baseUrl: 'http://127.0.0.1:1' } }), 'customer' as never, 'c-42');
    expect(page).toEqual({ records: [], nextCursor: 'c-42', hasMore: false });
  });

  it('extracts records + externalId from a bare-array response', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'ext-1', name: 'A' }, { id: 'ext-2', name: 'B' }]));
    });
    try {
      const adapter = new GenericRestAdapter();
      const page = await adapter.pullChanges(
        ctx({ config: { baseUrl: server.url, advanced: { endpoints: { customer: '/customers' } } } }),
        'customer' as never,
        null,
      );
      expect(page.records).toEqual([
        { externalId: 'ext-1', data: { id: 'ext-1', name: 'A' } },
        { externalId: 'ext-2', data: { id: 'ext-2', name: 'B' } },
      ]);
      expect(page.hasMore).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('page_number pagination: advances the page while a full page comes back, stops on a short page', async () => {
    const server = await startServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://x');
      const page = Number(url.searchParams.get('page'));
      const body = page === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '3' }]; // page 2 is short ⇒ end
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    try {
      const adapter = new GenericRestAdapter();
      const config = {
        baseUrl: server.url,
        advanced: { endpoints: { customer: '/customers' }, pagination: { strategy: 'page_number', pageSize: 2 } },
      };
      const page1 = await adapter.pullChanges(ctx({ config }), 'customer' as never, null);
      expect(page1.records.map((r) => r.externalId)).toEqual(['1', '2']);
      expect(page1.nextCursor).toBe('2');
      expect(page1.hasMore).toBe(true);

      const page2 = await adapter.pullChanges(ctx({ config }), 'customer' as never, page1.nextCursor);
      expect(page2.records.map((r) => r.externalId)).toEqual(['3']);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('cursor_param pagination: prefers the provider-declared nextCursor from the response envelope', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: '1' }], nextCursor: 'server-token-2' }));
    });
    try {
      const adapter = new GenericRestAdapter();
      const config = {
        baseUrl: server.url,
        advanced: { endpoints: { customer: '/customers' }, pagination: { strategy: 'cursor_param' } },
      };
      const page = await adapter.pullChanges(ctx({ config }), 'customer' as never, null);
      expect(page.nextCursor).toBe('server-token-2');
      expect(page.hasMore).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('cursor_param pagination: falls back to the last record\'s cursorField when the envelope has none', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: '1', updatedAt: '2026-01-01T00:00:00Z' }, { id: '2', updatedAt: '2026-01-02T00:00:00Z' }]));
    });
    try {
      const adapter = new GenericRestAdapter();
      const config = {
        baseUrl: server.url,
        advanced: {
          endpoints: { customer: '/customers' },
          pagination: { strategy: 'cursor_param' },
          cursorField: 'updatedAt',
        },
      };
      const page = await adapter.pullChanges(ctx({ config }), 'customer' as never, null);
      expect(page.nextCursor).toBe('2026-01-02T00:00:00Z');
    } finally {
      await server.close();
    }
  });

  it('surfaces a non-2xx response as a thrown error rather than fabricating an empty page', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    try {
      const adapter = new GenericRestAdapter();
      await expect(
        adapter.pullChanges(
          ctx({ config: { baseUrl: server.url, advanced: { endpoints: { customer: '/customers' } } } }),
          'customer' as never,
          null,
        ),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('drops malformed items missing an id rather than crashing the page', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'ok-1' }, { noId: true }]));
    });
    try {
      const adapter = new GenericRestAdapter();
      const page = await adapter.pullChanges(
        ctx({ config: { baseUrl: server.url, advanced: { endpoints: { customer: '/customers' } } } }),
        'customer' as never,
        null,
      );
      expect(page.records).toEqual([{ externalId: 'ok-1', data: { id: 'ok-1' } }]);
    } finally {
      await server.close();
    }
  });
});

describe('GenericRestAdapter — pushChanges', () => {
  it('POSTs new records and PUTs records with an externalId', async () => {
    const requests: { method?: string; path?: string; body: string }[] = [];
    const server = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ method: req.method, path: req.url, body });
        res.writeHead(200);
        res.end();
      });
    });
    try {
      const adapter = new GenericRestAdapter();
      const result = await adapter.pushChanges(
        ctx({ config: { baseUrl: server.url, advanced: { endpoints: { customer: '/customers' } } } }),
        'customer' as never,
        [
          { externalId: null, data: { name: 'new' } },
          { externalId: 'ext-9', data: { name: 'update' } },
        ],
      );
      expect(result).toEqual({ pushed: 2, failed: 0 });
      expect(requests[0]).toMatchObject({ method: 'POST', path: '/customers' });
      expect(requests[1]).toMatchObject({ method: 'PUT', path: '/customers/ext-9' });
    } finally {
      await server.close();
    }
  });

  it('is an honest no-op when no endpoint is configured', async () => {
    const adapter = new GenericRestAdapter();
    const result = await adapter.pushChanges(
      ctx({ config: { baseUrl: 'http://127.0.0.1:1' } }),
      'customer' as never,
      [{ externalId: 'x', data: {} }],
    );
    expect(result).toEqual({ pushed: 0, failed: 0 });
  });
});
