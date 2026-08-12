/**
 * Phase 9 (T089-T099, ZT-003) — every response Express serves carries the
 * approved API-appropriate header set, and a JSON response never carries a
 * document CSP. `contracts/backend-api-headers.md` is the source of truth
 * for every value asserted below.
 */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  registerSecurityHeaders,
  API_CONTENT_SECURITY_POLICY,
} from '../src/config/security-headers';
import { createE2eApp, type E2eApp } from './utils/whatsapp-e2e-app';

function expectApprovedHeaders(headers: Record<string, string | string[] | undefined>): void {
  expect(headers['content-security-policy']).toBe(API_CONTENT_SECURITY_POLICY);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-powered-by']).toBeUndefined();
}

describe('Backend security headers — API/webhook responses (ZT-003, Phase 9)', () => {
  describe('T097 — raw main.ts-only handlers (/, /api/v1/health)', () => {
    // Mirrors app.e2e-spec.ts's own bare-app + verbatim-handler-replication
    // pattern (main.ts's bootstrap() is never invoked directly in tests,
    // since it also calls app.listen()) — with registerSecurityHeaders added
    // in the same relative position main.ts registers it: after the
    // exception filter and global prefix, before both raw handlers.
    let app: INestApplication<App>;

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new AllExceptionsFilter());
      app.setGlobalPrefix('api/v1');
      registerSecurityHeaders(app);

      app.use('/api/v1/health', (_req, res) => {
        res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
      });
      app.use('/', (_req, res, next) => {
        if (_req.method === 'GET' && _req.url === '/') {
          return res.status(200).json({ status: 'ok', message: 'Clinic SaaS API is running' });
        }
        next();
      });

      await app.init();
    }, 60_000);

    afterAll(async () => {
      await app.close();
    });

    it('GET / carries the full approved header set and no X-Powered-By', async () => {
      const res = await request(app.getHttpServer()).get('/').expect(200);
      expectApprovedHeaders(res.headers);
    });

    it('GET /api/v1/health carries the full approved header set and no X-Powered-By', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expectApprovedHeaders(res.headers);
    });
  });

  describe('T097/T094/T096 — real AppModule responses via createE2eApp (the same registration main.ts uses)', () => {
    let e2e: E2eApp;

    beforeAll(async () => {
      e2e = await createE2eApp();
    }, 60_000);

    afterAll(async () => {
      await e2e.app.close();
    });

    it('an unauthenticated call to a protected route carries the approved headers on its 401 (JSON endpoint + exception-filter error response)', async () => {
      const res = await request(e2e.app.getHttpServer()).get('/api/v1/auth/me').expect(401);
      expectApprovedHeaders(res.headers);
    });

    it('a 404 on an unmatched route still carries the approved headers', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get('/api/v1/this-route-does-not-exist-010')
        .expect(404);
      expectApprovedHeaders(res.headers);
    });

    it('a real, mounted webhook callback carries the approved headers', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get('/api/v1/whatsapp/webhooks/verify')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'x' })
        .expect(403);
      expectApprovedHeaders(res.headers);
    });

    it('the API CSP contains no document-policy directive (no script-src, style-src, or nonce)', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get('/api/v1/this-route-does-not-exist-010')
        .expect(404);
      expect(res.headers['content-security-policy']).toBe(API_CONTENT_SECURITY_POLICY);
      expect(res.headers['content-security-policy']).not.toMatch(/script-src|style-src|nonce-/);
    });

    // T094 — the developer-machine protection: a plain-HTTP request must
    // never receive HSTS, even in production. NODE_ENV is forced to
    // 'production' for this one call (save/restore) so the test proves the
    // protocol gate itself, rather than passing vacuously because e2e runs
    // under a non-production NODE_ENV anyway.
    it('T094 — omits Strict-Transport-Security on a plain-HTTP request, even in production', async () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await request(e2e.app.getHttpServer())
          .get('/api/v1/this-route-does-not-exist-010')
          .expect(404);
        expect(res.headers['strict-transport-security']).toBeUndefined();
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    // T096 — O2 is an accepted, intentional exception, not an oversight:
    // engine.io answers /socket.io/ before Express routing ever runs, so
    // this middleware structurally cannot reach it. Proven here rather than
    // merely asserted in a comment.
    it('T096 — the Socket.IO engine.io handshake carries none of the Express-tier security headers (O2, intentional)', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get('/socket.io/')
        .query({ EIO: '4', transport: 'polling' })
        .expect(200);
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.headers['x-frame-options']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBeUndefined();
      expect(res.headers['referrer-policy']).toBeUndefined();
    });
  });

  describe('T097 — structural: createE2eApp registers the SAME function main.ts calls (FR-007)', () => {
    it('both call sites import registerSecurityHeaders from the shared security-headers module and invoke it', () => {
      const mainSource = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
      const factorySource = readFileSync(join(__dirname, 'utils/whatsapp-e2e-app.ts'), 'utf8');
      const importPattern = /import\s*\{\s*registerSecurityHeaders\s*\}\s*from\s*['"][^'"]*security-headers['"]/;

      expect(mainSource).toMatch(importPattern);
      expect(factorySource).toMatch(importPattern);
      expect(mainSource).toMatch(/registerSecurityHeaders\(app\)/);
      expect(factorySource).toMatch(/registerSecurityHeaders\(app\)/);
    });
  });
});
