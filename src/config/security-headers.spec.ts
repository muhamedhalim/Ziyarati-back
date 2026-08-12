import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import type { Request, Response } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'node:net';

import { registerSecurityHeaders, API_CONTENT_SECURITY_POLICY, HSTS_MAX_AGE_SECONDS } from './security-headers';

/**
 * Bare, business-module-free Nest app (mirrors `api-docs.spec.ts`'s own
 * pattern for ZT-001) — proves the registration itself needs no
 * database/queue/business-module dependency, and exercises the REAL
 * `registerSecurityHeaders` function `main.ts` calls, not a re-implementation.
 */
@Module({})
class EmptyTestModule {}

async function bootWithHeaders() {
  const app = await NestFactory.create(EmptyTestModule, { logger: false });
  registerSecurityHeaders(app);
  const instance = app.getHttpAdapter().getInstance();
  instance.get('/probe', (_req: Request, res: Response) => res.status(200).json({ ok: true }));
  await app.listen(0);
  const port = (app.getHttpServer() as Server).address() as AddressInfo | null;
  return { app, baseUrl: `http://127.0.0.1:${port?.port}` };
}

/** Mirrors `all-exceptions.filter.spec.ts`'s `withEnv` convention, async. */
const withEnv = async (env: string, fn: () => Promise<void>): Promise<void> => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  try {
    await fn();
  } finally {
    process.env.NODE_ENV = prev;
  }
};

describe('registerSecurityHeaders (ZT-003, contracts/backend-api-headers.md)', () => {
  describe('T091 — the API policy is never the document policy (FR-002, FR-004)', () => {
    it('contains no script-src, style-src, nonce, or upgrade-insecure-requests', () => {
      expect(API_CONTENT_SECURITY_POLICY).not.toMatch(/script-src/);
      expect(API_CONTENT_SECURITY_POLICY).not.toMatch(/style-src/);
      expect(API_CONTENT_SECURITY_POLICY).not.toMatch(/nonce-/);
      expect(API_CONTENT_SECURITY_POLICY).not.toMatch(/upgrade-insecure-requests/);
    });

    it('is exactly the default-src none policy the contract names', () => {
      expect(API_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    });

    it('emits that exact policy, plus every other approved header, on a real response', async () => {
      const { app, baseUrl } = await bootWithHeaders();
      try {
        const res = await request(baseUrl).get('/probe').expect(200);
        expect(res.headers['content-security-policy']).toBe(API_CONTENT_SECURITY_POLICY);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['x-frame-options']).toBe('DENY');
      } finally {
        await app.close();
      }
    });
  });

  describe('T093 — production HSTS value (FR-019, FR-020, SC-004a)', () => {
    it('carries max-age from the source constant, no includeSubDomains, no preload', async () => {
      const { app, baseUrl } = await bootWithHeaders();
      try {
        await withEnv('production', async () => {
          const res = await request(baseUrl).get('/probe').set('X-Forwarded-Proto', 'https').expect(200);
          const hsts = res.headers['strict-transport-security'];
          expect(hsts).toBeDefined();
          const tokens = (hsts as string).split(';').map((t) => t.trim());
          expect(tokens).toContain(`max-age=${HSTS_MAX_AGE_SECONDS}`);
          expect(tokens).not.toContain('includeSubDomains');
          expect(tokens).not.toContain('preload');
        });
      } finally {
        await app.close();
      }
    });
  });

  describe('T098 — environment-sensitive behaviour (FR-011, FR-018, FR-020)', () => {
    it('omits HSTS in development, regardless of protocol', async () => {
      const { app, baseUrl } = await bootWithHeaders();
      try {
        await withEnv('development', async () => {
          const httpRes = await request(baseUrl).get('/probe').expect(200);
          expect(httpRes.headers['strict-transport-security']).toBeUndefined();

          const httpsRes = await request(baseUrl).get('/probe').set('X-Forwarded-Proto', 'https').expect(200);
          expect(httpsRes.headers['strict-transport-security']).toBeUndefined();
        });
      } finally {
        await app.close();
      }
    });

    it('omits HSTS in production over plain HTTP (T094 unit-level counterpart)', async () => {
      const { app, baseUrl } = await bootWithHeaders();
      try {
        await withEnv('production', async () => {
          const res = await request(baseUrl).get('/probe').expect(200);
          expect(res.headers['strict-transport-security']).toBeUndefined();
        });
      } finally {
        await app.close();
      }
    });

    it('every non-HSTS header is identical across all four environment/protocol combinations', async () => {
      const { app, baseUrl } = await bootWithHeaders();
      try {
        const combos: Array<[string, boolean]> = [
          ['development', false],
          ['development', true],
          ['production', false],
          ['production', true],
        ];
        const seen: string[][] = [];
        for (const [env, https] of combos) {
          await withEnv(env, async () => {
            const pending = request(baseUrl).get('/probe');
            if (https) pending.set('X-Forwarded-Proto', 'https');
            const res = await pending.expect(200);
            seen.push([
              res.headers['content-security-policy'] as string,
              res.headers['x-content-type-options'] as string,
              res.headers['referrer-policy'] as string,
              res.headers['x-frame-options'] as string,
            ]);
          });
        }
        const [first, ...rest] = seen;
        for (const combo of rest) {
          expect(combo).toEqual(first);
        }
      } finally {
        await app.close();
      }
    });
  });
});
