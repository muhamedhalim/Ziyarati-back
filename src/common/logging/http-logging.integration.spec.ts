import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
  Injectable,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { requestContext } from '../middleware/request-context.middleware';
import { TenantContextInterceptor } from '../../core/tenant-context/tenant-context.interceptor';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { createHttpObservabilityMiddleware } from './http-access-log';
import { StructuredLogger } from './structured-logger';

/**
 * Phase 10 — the HTTP pipeline end to end, wired in the SAME order as main.ts:
 * observability middleware → requestContext → tenant ALS → guards → tenant
 * interceptor → handler → AllExceptionsFilter. Logs are captured from the
 * real StructuredLogger.
 */

/** Stands in for JwtAuthGuard: a principal only from a "verified" credential. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (req.headers['x-test-token'] === 'valid-user-token') {
      req.user = {
        id: 'user-42',
        tenantId: 'tenant-7',
        roles: ['owner'],
        permissions: [],
      };
    }
    return true;
  }
}

@Controller('things')
class ThingsController {
  private readonly logger = new Logger('ThingsController');

  @Get(':id')
  async get(@Param('id') id: string) {
    this.logger.log('before await');
    await new Promise((r) => setTimeout(r, 5));
    this.logger.log({
      event: 'thing.read.succeeded',
      message: 'after await',
      thing_id: id,
    });
    return { id };
  }
}

@Controller()
class FailingController {
  @Get('boom')
  boom(): never {
    throw new Error('database exploded for patient.fake@example.com');
  }

  @Get('private')
  private(): never {
    throw new UnauthorizedException();
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Post('auth/login')
  login(): never {
    throw new UnauthorizedException('Invalid credentials');
  }
}

describe('HTTP logging pipeline (integration)', () => {
  let app: INestApplication;
  let lines: string[];
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
  const access = () =>
    records().filter((r) => r.event === 'http.request.completed');

  beforeAll(async () => {
    lines = [];
    const logger = new StructuredLogger({
      role: 'api',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'debug',
        APP_REVISION: 'abc1234',
      },
      destination: { write: (s: string) => void lines.push(s) },
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [ThingsController, FailingController],
      providers: [
        TenantContextService,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger });
    app.useLogger(logger);
    const metrics = { recordHttpRequest: jest.fn() };
    app.use(
      createHttpObservabilityMiddleware({ metrics, clientIpMode: 'truncated' }),
    );
    app.use(requestContext);
    const tenantContext = app.get(TenantContextService);
    app.use((req: any, _res: unknown, next: () => void) =>
      tenantContext.run(() => {
        tenantContext.setCorrelationId(req.requestId ?? null);
        next();
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.setGlobalPrefix('api/v1');
    app.use('/api/v1/health', (_req: unknown, res: any) =>
      res.status(200).json({ status: 'ok' }),
    );
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    lines.length = 0;
  });

  // Access lines are written on 'finish' — let the event loop flush them.
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('generates and returns an X-Request-ID, and logs exactly one access line', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/things/abc?q=29801011234567&page=2',
    );
    await settle();
    expect(res.status).toBe(200);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const acc = access();
    expect(acc).toHaveLength(1);
    expect(acc[0]).toMatchObject({
      level: 'info',
      method: 'GET',
      route: '/api/v1/things/:id',
      status: 200,
      request_id: id,
      service: 'ziyaratech-api',
      env: 'production',
    });
    expect(typeof acc[0].duration_ms).toBe('number');
    // Route template only — never the raw path, the id or the query string.
    expect(JSON.stringify(acc[0])).not.toContain('29801011234567');
    expect(JSON.stringify(acc[0])).not.toContain('/things/abc');
  });

  it('carries the same request id into logs written across an await', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/things/xyz');
    await settle();
    const id = res.headers['x-request-id'];
    const handlerLines = records().filter(
      (r) => r.context === 'ThingsController',
    );
    expect(handlerLines.map((r) => r.message)).toEqual([
      'before await',
      'after await',
    ]);
    for (const r of handlerLines) expect(r.request_id).toBe(id);
  });

  it('honours a well-formed caller X-Request-ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/things/1')
      .set('X-Request-ID', 'gateway-abc.123:xyz');
    await settle();
    expect(res.headers['x-request-id']).toBe('gateway-abc.123:xyz');
    expect(access()[0].request_id).toBe('gateway-abc.123:xyz');
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['bad characters', 'abc def<script>'],
    ['log-injection attempt', 'abc","level":"fatal'],
  ])('replaces a malformed caller X-Request-ID (%s)', async (_label, bad) => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/things/1')
      .set('X-Request-ID', bad);
    await settle();
    expect(res.headers['x-request-id']).not.toBe(bad);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.join('')).not.toContain(bad);
  });

  it('records the authenticated user and tenant — and ignores a spoofed tenant header', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/things/1')
      .set('x-test-token', 'valid-user-token')
      .set('x-tenant-id', 'attacker-tenant');
    await settle();
    expect(access()[0]).toMatchObject({
      user_id: 'user-42',
      tenant_id: 'tenant-7',
    });
    for (const r of records().filter((x) => x.context === 'ThingsController')) {
      expect(r.tenant_id).toBe('tenant-7');
    }
    expect(lines.join('')).not.toContain('attacker-tenant');
  });

  it('logs no identity for an anonymous request', async () => {
    await request(app.getHttpServer()).get('/api/v1/things/1');
    await settle();
    expect(access()[0].user_id).toBeUndefined();
    expect(access()[0].tenant_id).toBeUndefined();
  });

  it('logs a 500 exactly once at error (the filter owns it) plus one info access line', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/boom');
    await settle();
    expect(res.status).toBe(500);
    expect(res.body.requestId).toBe(res.headers['x-request-id']); // API contract unchanged
    const errors = records().filter((r) => r.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      event: 'http.request.failed',
      status: 500,
      request_id: res.headers['x-request-id'],
      route: '/api/v1/boom',
    });
    expect(errors[0].error.stack).toContain('Error: database exploded');
    expect(lines.join('')).not.toContain('patient.fake@example.com');
    const acc = access();
    expect(acc).toHaveLength(1);
    expect(acc[0]).toMatchObject({ level: 'info', status: 500 });
  });

  it('classifies 401 / 403 / failed login as security events with the client address', async () => {
    await request(app.getHttpServer()).get('/api/v1/private');
    await request(app.getHttpServer()).get('/api/v1/forbidden');
    await request(app.getHttpServer()).post('/api/v1/auth/login');
    await settle();
    const events = records()
      .filter((r) => r.event !== 'http.request.completed')
      .map((r) => [r.event, r.level, r.reason]);
    expect(events).toEqual([
      ['auth.authentication.failed', 'warn', 'unauthenticated'],
      ['auth.authorization.denied', 'warn', 'forbidden'],
      ['auth.login.failed', 'warn', 'invalid_credentials'],
    ]);
    const login = records().find((r) => r.event === 'auth.login.failed')!;
    expect(login.client_ip).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it('logs routine health checks at debug only', async () => {
    await request(app.getHttpServer()).get('/api/v1/health');
    await settle();
    expect(access()).toHaveLength(1);
    expect(access()[0]).toMatchObject({
      level: 'debug',
      route: '/api/v1/health',
      status: 200,
    });
  });

  it('files unmatched paths under one route value (no cardinality explosion)', async () => {
    await request(app.getHttpServer()).get('/api/v1/random/scan/path/123');
    await settle();
    expect(access()[0]).toMatchObject({ route: 'unmatched', status: 404 });
    const rejected = records().find((r) => r.event === 'http.request.rejected');
    expect(rejected?.level).toBe('info');
  });
});
