import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { IntegrationConnectionTestService } from './connection-test.service';
import { CONNECTION_AUTH_TYPE } from '../integration-platform.constants';

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

const repoMock = (over: Partial<Record<string, jest.Mock>> = {}) => ({ findOne: jest.fn().mockResolvedValue(null), ...over } as any);
const encryption = { decrypt: jest.fn((v: string) => v.replace('ENC:', '')) } as any;
const admission = { admit: jest.fn().mockResolvedValue(undefined) } as any;
const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;

describe('IntegrationConnectionTestService', () => {
  const tenantId = 't1';
  const actor = { userId: 'u1', ip: '1.2.3.4' };

  it('rejects an unknown provider', async () => {
    const svc = new IntegrationConnectionTestService(repoMock(), encryption, admission, audit);
    await expect(svc.test(tenantId, { provider: 'does-not-exist' } as any, actor)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects oauth2 for a provider that does not declare it (no provider does today)', async () => {
    const svc = new IntegrationConnectionTestService(repoMock(), encryption, admission, audit);
    await expect(
      svc.test(tenantId, { provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.OAUTH2, config: { baseUrl: 'https://x.example.com' } } as any, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reports success for a reachable server, without persisting anything', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    try {
      const repo = repoMock();
      const svc = new IntegrationConnectionTestService(repo, encryption, admission, audit);
      const result = await svc.test(
        tenantId,
        { provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.NONE, config: { baseUrl: server.url } } as any,
        actor,
      );
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/Connected successfully/);
      expect(repo.findOne).not.toHaveBeenCalled(); // no connectionId ⇒ never touches the DB
      expect(admission.admit).toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('reports a clear failure for an unreachable server, never throwing', async () => {
    const svc = new IntegrationConnectionTestService(repoMock(), encryption, admission, audit);
    const result = await svc.test(
      tenantId,
      { provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.NONE, config: { baseUrl: 'http://127.0.0.1:1' } } as any,
      actor,
    );
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe('string');
  });

  it('fails fast (no network) when a credential is required but missing on a fresh draft', async () => {
    const svc = new IntegrationConnectionTestService(repoMock(), encryption, admission, audit);
    const result = await svc.test(
      tenantId,
      { provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.SECRET, config: { baseUrl: 'http://127.0.0.1:1' } } as any,
      actor,
    );
    expect(result).toEqual({ ok: false, message: 'A credential is required to test this connection' });
  });

  it('falls back to the EXISTING stored credential when testing an edit with no new secret typed', async () => {
    let seenAuth: string | undefined;
    const server = await startServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200);
      res.end();
    });
    try {
      const existing = {
        id: 'c1',
        provider: 'generic_rest',
        auth_type: CONNECTION_AUTH_TYPE.SECRET,
        credentials_ciphertext: 'ENC:stored-token',
        config: { baseUrl: server.url },
      };
      const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existing) });
      const svc = new IntegrationConnectionTestService(repo, encryption, admission, audit);
      const result = await svc.test(
        tenantId,
        { connectionId: 'c1', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.SECRET } as any,
        actor,
      );
      expect(result.ok).toBe(true);
      expect(seenAuth).toBe('Bearer stored-token'); // decrypted server-side, never supplied by the caller
    } finally {
      await server.close();
    }
  });

  it('404s when connectionId does not resolve for this tenant', async () => {
    const svc = new IntegrationConnectionTestService(repoMock({ findOne: jest.fn().mockResolvedValue(null) }), encryption, admission, audit);
    await expect(
      svc.test(tenantId, { connectionId: 'missing', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.NONE } as any, actor),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('verifies each configured resource endpoint individually, not just base connectivity', async () => {
    const server = await startServer((req, res) => {
      if (req.url?.startsWith('/customers')) {
        res.writeHead(200);
        res.end('[]');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    try {
      const svc = new IntegrationConnectionTestService(repoMock(), encryption, admission, audit);
      const result = await svc.test(
        tenantId,
        {
          provider: 'generic_rest',
          authType: CONNECTION_AUTH_TYPE.NONE,
          config: {
            baseUrl: server.url,
            advanced: {
              endpoints: {
                customer: { list: { path: '/customers', method: 'GET' } },
                staff: { list: { path: '/staff', method: 'GET' } },
              },
            },
          },
        } as any,
        actor,
      );
      expect(result.resources).toEqual(
        expect.arrayContaining([
          { resource: 'customer', ok: true, message: 'Reachable' },
          { resource: 'staff', ok: false, message: expect.stringContaining('HTTP 404') },
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it('omits `resources` entirely when no resource endpoint is configured', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    try {
      const svc = new IntegrationConnectionTestService(repoMock(), encryption, admission, audit);
      const result = await svc.test(
        tenantId,
        { provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.NONE, config: { baseUrl: server.url } } as any,
        actor,
      );
      expect(result.resources).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('never returns the credential in the result', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    try {
      const svc = new IntegrationConnectionTestService(repoMock(), encryption, admission, audit);
      const result = await svc.test(
        tenantId,
        {
          provider: 'generic_rest',
          authType: CONNECTION_AUTH_TYPE.SECRET,
          credential: 'super-secret-value',
          config: { baseUrl: server.url },
        } as any,
        actor,
      );
      expect(JSON.stringify(result)).not.toContain('super-secret-value');
    } finally {
      await server.close();
    }
  });
});
