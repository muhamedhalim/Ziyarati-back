/**
 * HTTP e2e bootstrap + fixtures for the WhatsApp / Campaign Meta Tech Provider
 * suite.
 *
 * Boots the REAL AppModule against the real dev Postgres + Redis (no sqlite /
 * in-memory substitute — TypeORM enum/jsonb columns don't translate), wired
 * exactly like `main.ts` (raw body, tenant-context middleware, exception
 * filter, global prefix, ValidationPipe). The two things that would otherwise
 * hit the real internet — `MetaGraphClient` and `MetaWhatsappProvider` — are
 * overridden with jest mocks, per "do not call real Meta APIs in tests".
 *
 * DATABASE ISOLATION: there is no per-test database. Every fixture is scoped
 * under a freshly-created Tenant (unique slug/email per call), and
 * `cleanupTenant` deletes every row it created, in FK-safe order, in
 * `afterAll`/`afterEach`. Tests must not touch data outside their own tenant.
 *
 * Deliberately does NOT set/clear META_* env vars — see
 * whatsapp-meta-env-configured.setup.ts / whatsapp-meta-env-unconfigured.setup.ts.
 * This module is shared by both the "configured" and "unconfigured" e2e
 * suites, so it cannot have an opinion on which state Meta config is in.
 */
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { randomUUID, createHmac } from 'node:crypto';
import cookieParser from 'cookie-parser';

import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { requestContext } from '../../src/common/middleware/request-context.middleware';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { ValidationPipe } from '@nestjs/common';
import { registerSecurityHeaders } from '../../src/config/security-headers';

import { MetaGraphClient } from '../../src/modules/whatsapp/meta/meta-graph.client';
import { MetaWhatsappProvider } from '../../src/modules/whatsapp/providers/meta-whatsapp.provider';

import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { User } from '../../src/entities/Auth&RBAC/User';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { TenantApprovalStatus } from '../../src/entities/enums';

export interface MetaGraphMock {
  exchangeCode: jest.Mock;
  debugToken: jest.Mock;
  listSharedWabas: jest.Mock;
  getWaba: jest.Mock;
  listPhoneNumbers: jest.Mock;
  subscribeAppToWaba: jest.Mock;
  listTemplates: jest.Mock;
  createTemplate: jest.Mock;
  getMediaMetadata: jest.Mock;
  downloadMedia: jest.Mock;
}

/** A fresh MetaGraphClient mock with sane defaults for a one-account, one-number WABA. */
export function createMetaGraphMock(
  overrides: Partial<MetaGraphMock> = {},
): MetaGraphMock {
  return {
    exchangeCode: jest
      .fn()
      .mockResolvedValue({ accessToken: 'mock-long-lived-token' }),
    // Reads process.env directly (not a shared constant) — by the time this
    // runs (inside createE2eApp(), called from a test's beforeAll), the
    // env-setup side-effect module has already run, and this way the mock
    // always agrees with whatever MetaConfig.requireAppId() actually reads,
    // with no risk of the two drifting apart.
    debugToken: jest.fn().mockImplementation(async () => ({
      appId: process.env.META_APP_ID,
      isValid: true,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    })),
    listSharedWabas: jest.fn().mockResolvedValue([]),
    getWaba: jest.fn().mockImplementation(async (wabaId: string) => ({
      id: wabaId,
      name: 'Mock Clinic WABA',
    })),
    // Derives the phone id from the WABA id (both supplied per-call by the
    // test as arbitrary unique strings) so onboarding two different tenants
    // in the same suite never collides on the DB's partial unique index on
    // `phone_number_id` — a fixed literal here would make the second
    // tenant's connect attempt fail with a real 409.
    listPhoneNumbers: jest.fn().mockImplementation(async (wabaId: string) => [
      {
        id: `phone-${wabaId}`,
        displayPhoneNumber: '+1 555 0100',
        verifiedName: 'Mock Clinic',
      },
    ]),
    subscribeAppToWaba: jest.fn().mockResolvedValue(undefined),
    listTemplates: jest.fn().mockResolvedValue([]),
    // `WhatsappTemplateService.create()`'s only external call — Meta's own
    // verdict is always PENDING at submission time (mapMetaTemplateStatus
    // maps it to PENDING_REVIEW); a unique-ish id per call keeps
    // `provider_template_id` distinct the same way the other mocks above
    // avoid colliding on tenant-scoped uniqueness constraints.
    createTemplate: jest.fn().mockImplementation(async () => ({
      id: `mock-meta-template-${randomUUID()}`,
      status: 'PENDING',
      category: undefined,
    })),
    getMediaMetadata: jest.fn().mockResolvedValue({
      url: 'https://mock.meta/media/1',
      mimeType: 'image/jpeg',
    }),
    downloadMedia: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('fake-image-bytes') }),
    ...overrides,
  };
}

export interface WhatsappProviderMock {
  name: string;
  supports: jest.Mock;
  send: jest.Mock;
  sendSession: jest.Mock;
}

export function createWhatsappProviderMock(): WhatsappProviderMock {
  return {
    name: 'mock-meta-whatsapp-cloud',
    supports: jest.fn().mockReturnValue(true),
    send: jest.fn().mockResolvedValue({
      success: true,
      providerMessageId: `mock-wamid-${randomUUID()}`,
    }),
    sendSession: jest.fn().mockResolvedValue({
      success: true,
      providerMessageId: `mock-wamid-${randomUUID()}`,
    }),
  };
}

export interface E2eApp {
  app: INestApplication;
  moduleRef: TestingModule;
  dataSource: DataSource;
  metaGraph: MetaGraphMock;
  whatsappProvider: WhatsappProviderMock;
  jwt: JwtService;
  config: ConfigService;
}

/**
 * Boots the app with the SAME middleware/pipe stack as `main.ts` (minus
 * Swagger, the health/root shims, and the Socket.IO Redis adapter — none of
 * which the HTTP/webhook scenarios below exercise).
 */
export async function createE2eApp(): Promise<E2eApp> {
  const metaGraph = createMetaGraphMock();
  const whatsappProvider = createWhatsappProviderMock();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MetaGraphClient)
    .useValue(metaGraph)
    .overrideProvider(MetaWhatsappProvider)
    .useValue(whatsappProvider)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });

  // ZT-003/FR-007 — the SAME registration main.ts's bootstrap() calls, so a
  // header assertion in this e2e suite exercises production's exact
  // middleware, never a differently-configured test double.
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

  return {
    app,
    moduleRef,
    dataSource: app.get(DataSource),
    metaGraph,
    whatsappProvider,
    jwt: app.get(JwtService),
    config: app.get(ConfigService),
  };
}

export interface OwnerFixture {
  tenantId: string;
  userId: string;
  token: string;
  email: string;
}

/**
 * Creates an APPROVED, active tenant + an owner user (the pre-seeded system
 * "owner" role — see `role-permissions.seed.ts` — already carries every
 * whatsapp / campaign / conversation permission these tests need) and mints a
 * real access JWT the same shape `AuthService.issueTokens` produces.
 */
export async function createOwnerFixture(
  e2e: E2eApp,
  label: string,
): Promise<OwnerFixture> {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const tenants = e2e.dataSource.getRepository(Tenant);
  const users = e2e.dataSource.getRepository(User);
  const roles = e2e.dataSource.getRepository(Role);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const tenant = await tenants.save(
    tenants.create({
      name: `E2E Clinic ${suffix}`,
      slug: `e2e-${suffix}`,
      contact_email: `e2e-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );

  // The pre-seeded SYSTEM role (tenant IS NULL) — never a tenant's own custom
  // role of the same slug, which is why this can't be a plain `findOne`.
  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: 'owner' })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) {
    throw new Error(
      'Seeded system role "owner" not found — run the RBAC seed (src/seed) against the test database first.',
    );
  }

  const user = await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email: `owner-${suffix}@example.test`,
      full_name: `E2E Owner ${suffix}`,
      is_active: true,
    }),
  );
  await userRoles.save(
    userRoles.create({
      user: { id: user.id } as User,
      role: { id: role.id } as Role,
    }),
  );

  const token = await e2e.jwt.signAsync(
    { sub: user.id, tenantId: tenant.id, type: 'access' },
    {
      secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: '15m',
    },
  );

  return { tenantId: tenant.id, userId: user.id, token, email: user.email! };
}

export function authHeader(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

/**
 * Deletes every row this suite could have created under `tenantId`, in
 * FK-safe order (children before parents). Never touches another tenant's
 * data — every query is scoped by tenantId (directly or via a join).
 */
export async function cleanupTenant(
  e2e: E2eApp,
  tenantId: string,
): Promise<void> {
  const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
  // Every HTTP request the tests made against this tenant left a request-log
  // row with an FK to it — delete those first or the final tenant DELETE 409s.
  await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM notification_logs WHERE "tenantId" = $1`);
  // Only populated if a real worker happens to run an analytics job against
  // this tenant while the test is still live (e.g. a manual worker boot
  // during local debugging) — harmless no-op otherwise.
  await q(`DELETE FROM dashboard_metrics WHERE "tenantId" = $1`);
  await q(`DELETE FROM message_status_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM message_attachments WHERE "tenantId" = $1`);
  await q(`DELETE FROM messages WHERE "tenantId" = $1`);
  await q(`DELETE FROM conversations WHERE "tenantId" = $1`);
  await q(
    `DELETE FROM campaign_recipients WHERE "runId" IN (SELECT id FROM campaign_runs WHERE "tenantId" = $1)`,
  );
  await q(`DELETE FROM campaign_runs WHERE "tenantId" = $1`);
  await q(`DELETE FROM campaigns WHERE "tenantId" = $1`);
  await q(`DELETE FROM whatsapp_webhooks WHERE "tenantId" = $1`);
  await q(`DELETE FROM whatsapp_templates WHERE "tenantId" = $1`);
  await q(`DELETE FROM whatsapp_contacts WHERE "tenantId" = $1`);
  await q(`DELETE FROM whatsapp_accounts WHERE "tenantId" = $1`);
  // Uploaded-file metadata (ZT-004b coverage is the first e2e path to create
  // rows here) — children of `customers` / `tenants` respectively, so both
  // must go before the deletes below.
  await q(`DELETE FROM customer_files WHERE "tenantId" = $1`);
  await q(`DELETE FROM ai_training_files WHERE "tenantId" = $1`);
  await q(`DELETE FROM customers WHERE "tenantId" = $1`);
  await q(
    `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
  );
  await q(`DELETE FROM users WHERE "tenantId" = $1`);
  // Request logging is async (fire-and-forget), so a row for the very last
  // HTTP call in a test can still land after the FIRST api_logs delete above
  // — delete again immediately before the tenant row it FKs to.
  await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM tenants WHERE id = $1`);
}

/**
 * HMAC-SHA256 signature Meta sends as `X-Hub-Signature-256`, over the EXACT
 * raw bytes. `secret` is required (not defaulted from a shared constant here)
 * — see the module docstring for why this file must stay opinion-free about
 * Meta env; callers import `TEST_META_ENV` from their own env-setup module.
 */
export function signWebhookBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(rawBody)).digest('hex')}`;
}
