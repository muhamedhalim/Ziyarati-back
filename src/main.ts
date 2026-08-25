import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { requestContext } from './common/middleware/request-context.middleware';
import { TenantContextService } from './core/tenant-context/tenant-context.service';
import { MetricsService } from './metrics/metrics.service';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { RedisIoAdapter } from './modules/ai-realtime/redis-io.adapter';
import { runClustered } from './cluster-bootstrap';
import { mountApiDocs } from './config/api-docs';
import { registerSecurityHeaders } from './config/security-headers';
import { parseAllowedOrigins } from './config/cors-origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // ---------------- HTTP request duration (PERF-BE-002) ----------------
  // Registered before every other middleware/guard so it observes 100% of
  // requests, including the ones the 6 global guards reject (429/401/403/503)
  // — T025's empirically-confirmed gap: ApiLoggingInterceptor sits AFTER the
  // guard chain and never sees these. Pure timing + a status-code counter,
  // no body/header access, no auth/tenant/rate-limit decision touched.
  const metrics = app.get(MetricsService);
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      metrics.recordHttpRequest(req.method, res.statusCode, durationSeconds);
    });
    next();
  });

  // ---------------- Response compression (PERF-BE-001) ----------------
  // Response-side only — wraps res.write/res.end, runs after guards/handlers
  // have already decided the body, so it cannot affect auth, tenant scoping,
  // rate limiting or CSRF (all request-side / Nest-guard concerns). Registered
  // first purely by convention (compress every downstream response); order
  // relative to the other middleware below does not matter since none of them
  // read or transform the outgoing body. Default 1024-byte threshold and the
  // default `compressible`-mimetype filter both apply — the whole app returns
  // JSON or `text/plain` (T146: no streaming/SSE/binary-download response
  // exists anywhere in this codebase), so nothing needs an explicit filter.
  app.use(compression());

  // ---------------- Request correlation id ----------------
  // Registered first so every downstream layer (guards, routes, filter) sees it.
  app.use(requestContext);

  // ---------------- Tenant runtime context ----------------
  // Open an AsyncLocalStorage store per request. The whole Nest pipeline
  // (guards → interceptors → controllers → services) runs inside next(), so
  // TenantContextService is available everywhere downstream. It is *populated*
  // by TenantContextInterceptor once authentication has set request.user.
  const tenantContext = app.get(TenantContextService);
  app.use((req, _res, next) =>
    tenantContext.run(() => {
      // `requestContext` (registered above) set req.requestId; propagate it so
      // enqueued jobs and logs carry the correlation id.
      tenantContext.setCorrelationId(
        (req as { requestId?: string }).requestId ?? null,
      );
      next();
    }),
  );

  // ---------------- Global Exception Filter ----------------
  // Catches everything (HttpException, TypeORM errors, runtime errors) and
  // renders the single canonical error shape. Applies to ALL modules.
  app.useGlobalFilters(new AllExceptionsFilter());

  // ---------------- Cookie parser ----------------
  // Required to READ cookies (req.cookies) for cookie-based auth + CSRF.
  app.use(cookieParser());

  // ---------------- CORS ----------------
  // Cookie auth requires an explicit origin allow-list with credentials — a
  // wildcard origin is both invalid alongside credentials and unsafe. Set
  // FRONTEND_ORIGIN as a comma-separated list (defaults to the dev SPA origin).
  // Parsed by the shared helper so REST and the `/ai` gateway can never
  // disagree about which origins are legitimate — see cors-origins.ts for why
  // the entries are normalized rather than merely split.
  const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_ORIGIN);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  // The resolved allow-list, once, at boot. Not diagnostic noise: a
  // FRONTEND_ORIGIN matching no real browser origin fails *silently* — the API
  // boots, same-origin-proxied REST keeps working, and only genuinely
  // cross-origin traffic (the realtime polling fallback) is refused — so the
  // effective value has to be visible somewhere. Origins are public by
  // definition; no secret is printed.
  new Logger('Bootstrap').log(`CORS allow-list: ${allowedOrigins.join(', ')}`);

  // ---------------- Global Prefix ----------------
  app.setGlobalPrefix('api/v1');

  // ---------------- Global Validation ----------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ---------------- API documentation (ZT-001: gated, not unconditional) ----------------
  // Both documents are controlled by their OWN independent flag, each
  // defaulting to disabled in production (env.validation.ts). See
  // config/api-docs.ts for why gating skips the mount entirely rather than
  // guarding a mounted route.
  mountApiDocs(app, app.get(ConfigService));

  // ---------------- Security headers + framework disclosure (ZT-003, ZT-H07) ----------------
  // Registered before the raw `/` and `/api/v1/health` handlers below so
  // both are covered, along with every 404 and exception-filter response —
  // Express threads the same `res` through the rest of the chain, so headers
  // set here persist onto whatever later handler sends the response. Also
  // disables `X-Powered-By` (an app-level Express setting checked at
  // response-send time, not order-dependent the way the header middleware
  // is) — both live in the one function so `test/utils/whatsapp-e2e-app.ts`'s
  // `createE2eApp` exercises the exact same disclosure posture production
  // does, not a partial replica (FR-006, FR-007).
  registerSecurityHeaders(app);

  // ---------------- Health Route ----------------
  app.use('/api/v1/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // ---------------- Root Route ----------------
  app.use('/', (_req, res, next) => {
    if (_req.method === 'GET' && _req.url === '/') {
      return res.status(200).json({
        status: 'ok',
        message: 'Clinic SaaS API is running',
        docs: '/api/v1/docs',
        integrationDocs: '/docs/integrations',
        health: '/api/v1/health',
      });
    }
    next();
  });

  // ---------------- Realtime AI gateway (Socket.IO + Redis adapter) ----------------
  // Enables horizontal scaling of the /ai WebSocket namespace across instances.
  // Soft: falls back to the in-memory adapter when REDIS_URL is absent/unreachable.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // ---------------- Graceful shutdown ----------------
  // Gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.8. Without this,
  // NestJS's `onModuleDestroy` lifecycle hooks NEVER run on the API process: a
  // plain `NestFactory.create()` app only wires them up if something actually
  // calls `app.close()`, and nothing here ever did — SIGTERM (every normal
  // deploy/restart) just killed the process outright. That silently skipped
  // `ProducerQueues.onModuleDestroy()` (and every other module's cleanup),
  // leaking its Redis producer connections on every single restart rather than
  // closing them — the exact gap this closes. Mirrors `worker.ts`'s identical
  // manual SIGTERM/SIGINT handling for consistency across both processes.
  const logger = new Logger('Bootstrap');
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Received ${signal} — closing HTTP server and cleaning up…`);
    try {
      await app.close(); // runs onModuleDestroy on every module, incl. ProducerQueues
      logger.log('API shut down cleanly.');
      process.exit(0);
    } catch (err) {
      logger.error(`Error during shutdown: ${(err as Error)?.message}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ---------------- Start Server ----------------
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
}

// PERF-INFRA-003 — process-level scaling. Default (API_CLUSTER_WORKERS unset
// or 1) runs bootstrap() directly in this process, unchanged from before this
// finding. See cluster-bootstrap.ts's own docstring for the full safety case.
runClustered(bootstrap);
