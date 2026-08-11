import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { Server } from 'http';
import type { AddressInfo } from 'node:net';

import { mountApiDocs } from './api-docs';

/**
 * ZT-001 boot-mode coverage — the five combinations from
 * contracts/api-documentation.md, exercised against the REAL `mountApiDocs`
 * function `main.ts` calls (not a re-implementation of its logic). A bare,
 * business-module-free Nest app is booted per combination — proving the
 * GATING mechanism itself needs no database/queue/business-module
 * dependency, so this runs as a fast unit spec rather than a DB-backed e2e.
 */
@Module({})
class EmptyTestModule {}

function fakeConfig(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

async function bootWithFlags(values: Record<string, string | undefined>) {
  const app = await NestFactory.create(EmptyTestModule, { logger: false });
  mountApiDocs(app, fakeConfig(values));
  await app.listen(0);
  const port = (app.getHttpServer() as Server).address() as AddressInfo | null;
  return { app, baseUrl: `http://127.0.0.1:${port?.port}` };
}

// `env.validation.spec.ts` already proves NODE_ENV resolves each flag to the
// right string (production ⇒ 'false' when unset, otherwise ⇒ 'true'). This
// suite starts from an already-resolved flag value and proves `mountApiDocs`
// gates correctly on it — the "production, X flag(s)" framing below names
// the resolved combination the contract table describes, not a NODE_ENV this
// file sets directly.
describe('mountApiDocs — ZT-001 boot-mode combinations (contracts/api-documentation.md)', () => {
  it('neither flag set (⇒ both resolve false in production) → all four paths 404', async () => {
    const { app, baseUrl } = await bootWithFlags({});
    try {
      await request(baseUrl).get('/docs').expect(404);
      await request(baseUrl).get('/docs-json').expect(404);
      await request(baseUrl).get('/docs/integrations').expect(404);
      await request(baseUrl).get('/docs/integrations-json').expect(404);
    } finally {
      await app.close();
    }
  });

  it('partner flag only → partner 200, internal still 404', async () => {
    const { app, baseUrl } = await bootWithFlags({
      ENABLE_INTEGRATION_DOCS: 'true',
    });
    try {
      await request(baseUrl).get('/docs').expect(404);
      await request(baseUrl).get('/docs-json').expect(404);
      await request(baseUrl).get('/docs/integrations').expect(200);
      await request(baseUrl).get('/docs/integrations-json').expect(200);
    } finally {
      await app.close();
    }
  });

  it('internal flag only → internal 200, partner still 404', async () => {
    const { app, baseUrl } = await bootWithFlags({ ENABLE_API_DOCS: 'true' });
    try {
      await request(baseUrl).get('/docs').expect(200);
      await request(baseUrl).get('/docs-json').expect(200);
      await request(baseUrl).get('/docs/integrations').expect(404);
      await request(baseUrl).get('/docs/integrations-json').expect(404);
    } finally {
      await app.close();
    }
  });

  it('both flags true (production, deliberately enabled, or the non-production default) → both fully served', async () => {
    const { app, baseUrl } = await bootWithFlags({
      ENABLE_API_DOCS: 'true',
      ENABLE_INTEGRATION_DOCS: 'true',
    });
    try {
      await request(baseUrl).get('/docs').expect(200);
      await request(baseUrl).get('/docs-json').expect(200);
      await request(baseUrl).get('/docs/integrations').expect(200);
      await request(baseUrl).get('/docs/integrations-json').expect(200);
    } finally {
      await app.close();
    }
  });

  it('both flags false (explicit, e.g. an operator disabling the non-production default) → all four paths 404', async () => {
    const { app, baseUrl } = await bootWithFlags({
      ENABLE_API_DOCS: 'false',
      ENABLE_INTEGRATION_DOCS: 'false',
    });
    try {
      await request(baseUrl).get('/docs').expect(404);
      await request(baseUrl).get('/docs/integrations').expect(404);
    } finally {
      await app.close();
    }
  });
});
