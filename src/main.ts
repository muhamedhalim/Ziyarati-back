import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { requestContext } from './common/middleware/request-context.middleware';
import { TenantContextService } from './core/tenant-context/tenant-context.service';
import cookieParser from 'cookie-parser';
import { RedisIoAdapter } from './modules/ai-realtime/redis-io.adapter';
import { IntegrationModule } from './modules/integration/integration.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

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
      tenantContext.setCorrelationId((req as { requestId?: string }).requestId ?? null);
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
  const allowedOrigins = (
    process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

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

  // ---------------- Swagger Config ----------------
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Clinic SaaS API')
    .setDescription('Auth + RBAC + Multi Tenant System')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      'JWT-auth',
    )
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);

  // Require the bearer scheme on EVERY operation, so clicking "Authorize" once
  // attaches `Authorization: Bearer <token>` to all requests (public routes
  // simply ignore it). Without this, only operations decorated with
  // @ApiBearerAuth('JWT-auth') send the token — the rest hit "No auth token".
  swaggerDocument.security = [{ 'JWT-auth': [] }];

  SwaggerModule.setup('docs', app, swaggerDocument, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // ---------------- Integration API docs (separate, external-facing) ----------------
  // A distinct document scoped to ONLY the external integration controllers —
  // internal admin/dashboard routes must never appear here. Authenticated with
  // an API key (never the JWT bearer scheme above), so it gets its own
  // security scheme rather than reusing 'JWT-auth'.
  const integrationSwaggerConfig = new DocumentBuilder()
    .setTitle('Ziyarati Integration API')
    .setDescription(
      `
Read-only API for connecting an existing clinic system to Ziyarati.

**Authentication** — every request needs an API key, created from the clinic's
Developer Options page. Send it as either:
- \`X-API-Key: zk_...\`, or
- \`Authorization: ApiKey zk_...\`

**Scopes** — a key only works for the scopes it was granted at creation
(e.g. \`integration.services.read\`). A request to an endpoint the key wasn't
granted the scope for returns 403.

**Pagination** — list endpoints accept \`page\` (1-based) and \`limit\` (max 100)
and return \`{ data, total, page, limit }\`.

**Rate limits** — each key is limited per minute (429 \`RATE_LIMITED\` when
exceeded, with a \`context.retryAfterMs\` hint). The limit is configured per
deployment.

**Errors** — every error response has the shape
\`{ statusCode, code, error, message, path, timestamp, requestId, context? }\`.
Clients should branch on \`code\`. Common codes: \`UNAUTHORIZED\`
(missing/invalid/expired/revoked key, or the owning clinic is suspended),
\`FORBIDDEN\` (missing scope), \`NOT_FOUND\` (unknown id, or the resource belongs
to another clinic), \`VALIDATION_ERROR\` (bad query params), \`RATE_LIMITED\`.
      `.trim(),
    )
    .setVersion('1.0')
    .addApiKey(
      { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      'ApiKey-auth',
    )
    .build();

  const integrationSwaggerDocument = SwaggerModule.createDocument(
    app,
    integrationSwaggerConfig,
    { include: [IntegrationModule] },
  );
  integrationSwaggerDocument.security = [{ 'ApiKey-auth': [] }];

  SwaggerModule.setup('docs/integrations', app, integrationSwaggerDocument, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

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

  // ---------------- Start Server ----------------
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap();