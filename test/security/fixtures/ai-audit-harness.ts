/**
 * Audit test harness for Feature 011 (AI security audit).
 *
 * Boots the REAL `AppModule` (same middleware/pipe stack as `main.ts`, mirroring
 * `test/utils/whatsapp-e2e-app.ts`'s `createE2eApp()` — reused pattern, not a new
 * one, per plan.md's Principle V requirement) against the real e2e Postgres and
 * Redis, with exactly two provider overrides:
 *
 *  - `AI_COMPLETION_PROVIDERS` → `[ScriptedAiProvider]` (chat/tool-calling seam)
 *  - `AI_EMBEDDING_PROVIDER`   → `ScriptedEmbeddingProvider` (RAG/ingestion seam)
 *
 * Both overrides are unconditional — never gated on whether a given test
 * "looks like" it needs AI — because `.env` carries a live `OPENAI_API_KEY`
 * (environment-record.md §provider) and nothing else in the ambient test
 * environment prevents a real provider call (FR-103).
 *
 * pgvector mode: pass `{ pgvector: true }` to point the boot at the pgvector-
 * capable Postgres override (`zt-audit-pgvector`, host port 5434 — see
 * environment-record.md §pgvector) instead of the default compose Postgres
 * (5433, no pgvector extension). The pgvector-mode database must already be
 * migrated and RBAC-seeded — see `provision-pgvector-db.ts`, run once before any
 * W5 vector-path spec (T066/T067).
 */
import { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import cookieParser from 'cookie-parser';

// AppModule is deliberately NOT imported statically at module top-level — see
// the "pgvector mode" note inside buildAiAuditHarness() below for why.
import type { AppModule as AppModuleType } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { requestContext } from '../../../src/common/middleware/request-context.middleware';
import { TenantContextService } from '../../../src/core/tenant-context/tenant-context.service';
import { registerSecurityHeaders } from '../../../src/config/security-headers';
import {
  AI_COMPLETION_PROVIDERS,
  AI_EMBEDDING_PROVIDER,
} from '../../../src/modules/ai/providers/ai-provider.interface';
import { PgVectorBootstrapService } from '../../../src/modules/ai/rag/pgvector-bootstrap.service';

import { ScriptedAiProvider } from './scripted-ai-provider';
import { ScriptedEmbeddingProvider } from './scripted-ai-embedding-provider';

/** Small, fast embedding dimension for pgvector-mode boots — see provision-pgvector-db.ts. */
export const AUDIT_EMBEDDING_DIM = 16;

export interface AiAuditHarnessOptions {
  /** Boot against the pgvector-capable Postgres override (port 5434) instead of the default compose Postgres (5433, no pgvector). Default: false. */
  pgvector?: boolean;
}

export interface AiAuditHarness {
  app: INestApplication;
  moduleRef: TestingModule;
  dataSource: DataSource;
  provider: ScriptedAiProvider;
  embedding: ScriptedEmbeddingProvider;
  jwt: JwtService;
  config: ConfigService;
  /** True only when pgvector mode was requested AND `PgVectorBootstrapService` actually reports itself available (T067's path proof). */
  pgvectorAvailable: boolean;
  close(): Promise<void>;
}

/**
 * Boots one isolated Nest application instance for a single spec file. Each
 * call creates fresh `ScriptedAiProvider`/`ScriptedEmbeddingProvider`
 * instances — tests must not share a harness across `describe` blocks that
 * need independent capture state; call `close()` in `afterAll`.
 */
export async function buildAiAuditHarness(options: AiAuditHarnessOptions = {}): Promise<AiAuditHarness> {
  if (options.pgvector) {
    // Must be set before `app.module.ts` is evaluated for the FIRST time in this
    // process — NOT merely before `.compile()`. Empirically verified (T067 dry
    // run): `AppModule`'s `ConfigModule.forRoot({ envFilePath: '.env', cache:
    // true, validate })` (app.module.ts:71-76) loads and Joi-validates env into a
    // cached snapshot as a SIDE EFFECT of evaluating that `@Module({ imports:
    // [...] })` decorator argument — which happens the moment `app.module.ts` is
    // first `require()`'d (a static top-level `import` at the top of a spec file
    // runs before ANY of that file's own code, including this function body), NOT
    // when Nest later instantiates `ConfigService` during `Test...compile()`. A
    // static `import { AppModule } from '.../app.module'` at this file's own
    // top-level therefore locked in whatever `DATABASE_URL` `jest-e2e.env.js`'s
    // `setupFiles` had already set (port 5433) — the `{ pgvector: true }` mutation
    // below ran too late to matter, and every "pgvector-mode" boot silently
    // connected to the NON-pgvector database instead (confirmed by querying
    // `dataSource.options.url` afterward: it read port 5433 even though
    // `process.env.DATABASE_URL` correctly read 5434 at that same moment — proof
    // the mutation and the actual connection had already diverged). Fix: `AppModule`
    // is now required LAZILY (below), after these env mutations, instead of via a
    // static top-of-file import — see the `require()` call after this block.
    process.env.DB_PORT = '5434';
    process.env.DATABASE_URL = `postgres://${process.env.DB_USERNAME ?? 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD ?? '')}@${process.env.DB_HOST ?? '127.0.0.1'}:5434/${process.env.DB_NAME ?? 'ziyarati_e2e'}`;
    process.env.OPENAI_EMBEDDING_DIM = String(AUDIT_EMBEDDING_DIM);
    process.env.AI_PGVECTOR_ENABLED = 'true';
  }

  // Lazy require (NOT a top-level `import`) — see the long comment above. Must be
  // the first evaluation of `app.module.ts` in this process; if some other file
  // already imported it first, the pgvector env override is a no-op (ConfigModule's
  // `cache: true` snapshot already exists) — every AI-audit harness caller adheres
  // to "boots one isolated Nest application instance for a single spec file" (this
  // function's own docstring), so in practice this is always the first evaluation.
  //
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppModule } = require('../../../src/app.module') as { AppModule: typeof AppModuleType };

  const provider = new ScriptedAiProvider();
  const embedding = new ScriptedEmbeddingProvider(options.pgvector ? AUDIT_EMBEDDING_DIM : 16);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(AI_COMPLETION_PROVIDERS)
    .useValue([provider])
    .overrideProvider(AI_EMBEDDING_PROVIDER)
    .useValue(embedding)
    .compile();

  // `{ rawBody: true }` mirrors main.ts:17 exactly — without it `req.rawBody`
  // is never populated, so ANY webhook-signature spec (raw-byte HMAC, e.g.
  // WhatsApp's X-Hub-Signature-256) would see every request rejected at the
  // "missing raw request body" branch regardless of whether the signature is
  // actually correct — a harness gap that made the negative cases pass for
  // the wrong reason and made the positive case impossible (found while
  // writing T128's webhook-verification spec).
  const app = moduleRef.createNestApplication({ rawBody: true });

  // Same registration order as main.ts / createE2eApp() — the audit exercises
  // production's exact middleware stack, never a differently-configured double.
  registerSecurityHeaders(app);
  const tenantContext = app.get(TenantContextService);
  app.use(requestContext);
  app.use((req: { requestId?: string }, _res: unknown, next: () => void) =>
    tenantContext.run(() => {
      tenantContext.setCorrelationId(req.requestId ?? null);
      next();
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.init();

  const bootstrap = app.get(PgVectorBootstrapService, { strict: false });
  const pgvectorAvailable = !!bootstrap?.isAvailable?.();

  return {
    app,
    moduleRef,
    dataSource: app.get(DataSource),
    provider,
    embedding,
    jwt: app.get(JwtService),
    config: app.get(ConfigService),
    pgvectorAvailable,
    close: async () => {
      await app.close();
    },
  };
}
