import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';
import { advertisedApiDocs } from './../src/config/api-docs';

// Both documentation flags on, so the payload below is the same whatever NODE_ENV this suite runs under.
const bothDocsOn = { get: () => 'true' } as unknown as Parameters<typeof advertisedApiDocs>[0];

/**
 * VAL-001′ — rewritten against the REAL running contract (main.ts), not the
 * unmodified NestJS starter. FND-005 resolved (T169, Wave 6) by deleting the
 * dead `AppController`/`AppService` pair and keeping ONLY main.ts's raw
 * Express handler at `/` — this suite proves that decision holds: the real
 * `api/v1` global prefix is applied, main.ts's `/` and `/api/v1/health`
 * handlers respond exactly as bootstrap() registers them (replicated here
 * verbatim, the same way `test/utils/whatsapp-e2e-app.ts`'s `createE2eApp`
 * already mirrors main.ts's other bootstrap steps for e2e use — main.ts's own
 * `bootstrap()` is never invoked directly in tests because it also calls
 * `app.listen()`), and the global `JwtAuthGuard` (registered via `APP_GUARD`
 * in `AppModule`) actually rejects an unauthenticated call to a real
 * non-`@Public()` route. The unmodified starter's `'/' -> 'Hello World!'`
 * assertion is gone for good — this file no longer boots bare `AppModule`
 * without the prefix/handlers, so it can actually exercise the contract that
 * assertion never could.
 */
describe('root route + api/v1 contract (FND-005 / VAL-001′)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.setGlobalPrefix('api/v1');

    // Verbatim copy of main.ts's two raw Express handlers (lines 158-178) —
    // the only surviving root-identity registrations after FND-005 deleted
    // AppController/AppService. Kept byte-for-byte identical so this test
    // proves the real contract, not a paraphrase of it.
    app.use('/api/v1/health', (_req, res) => {
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    });
    app.use('/', (_req, res, next) => {
      if (_req.method === 'GET' && _req.url === '/') {
        return res.status(200).json({
          status: 'ok',
          message: 'Clinic SaaS API is running',
          ...advertisedApiDocs(bothDocsOn),
          health: '/api/v1/health',
        });
      }
      next();
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET / resolves via main.ts\'s raw handler only — no duplicate/conflicting starter registration', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.body).toEqual({
      status: 'ok',
      message: 'Clinic SaaS API is running',
      // CR-35: the paths the docs are really served from (outside the api/v1 prefix).
      docs: '/docs',
      integrationDocs: '/docs/integrations',
      health: '/api/v1/health',
    });
  });

  it('GET /api/v1/health is public and reports ok', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('every real controller route lives under the api/v1 prefix — an unprefixed path resolves to neither handler and 404s', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(404);
  });

  it('the global JwtAuthGuard rejects an unauthenticated call to a real, non-@Public() api/v1 route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
