import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { requestContext } from './common/middleware/request-context.middleware';
import { TenantContextService } from './core/tenant-context/tenant-context.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ---------------- Request correlation id ----------------
  // Registered first so every downstream layer (guards, routes, filter) sees it.
  app.use(requestContext);

  // ---------------- Tenant runtime context ----------------
  // Open an AsyncLocalStorage store per request. The whole Nest pipeline
  // (guards → interceptors → controllers → services) runs inside next(), so
  // TenantContextService is available everywhere downstream. It is *populated*
  // by TenantContextInterceptor once authentication has set request.user.
  const tenantContext = app.get(TenantContextService);
  app.use((_req, _res, next) => tenantContext.run(() => next()));

  // ---------------- Global Exception Filter ----------------
  // Catches everything (HttpException, TypeORM errors, runtime errors) and
  // renders the single canonical error shape. Applies to ALL modules.
  app.useGlobalFilters(new AllExceptionsFilter());

  // ---------------- CORS ----------------
  app.enableCors({
    origin: true,
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

  // Swagger under global prefix (recommended)
  SwaggerModule.setup('docs', app, swaggerDocument, {
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
        health: '/api/v1/health',
      });
    }
    next();
  });

  // ---------------- Start Server ----------------
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap();