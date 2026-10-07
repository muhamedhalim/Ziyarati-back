import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { MerchantAccount } from '../../entities/Payments/MerchantAccount';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../../common/errors';
import {
  createMockConfigService,
  createMockDataSource,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportIntegrationService } from './support-integration.service';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';

/**
 * `dataSource.query` is called with different SQL per probe, so the double
 * routes on a distinguishing substring rather than on call order — otherwise
 * a future reordering inside `overview()` would silently rewire the fixtures.
 */
function routeQuery(routes: Array<[RegExp, unknown]>) {
  return jest.fn(async (sql: string) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) return result;
    }
    return [];
  });
}

describe('SupportIntegrationService', () => {
  let service: SupportIntegrationService;
  let tenants: MockRepository;
  let merchants: MockRepository;
  let settings: MockRepository;
  let dataSource: MockDataSource;
  let storage: { isConfigured: jest.Mock };

  const build = async (config: Record<string, unknown> = {}) => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportIntegrationService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(WhatsappAccount), useValue: createMockRepository() },
        { provide: getRepositoryToken(MerchantAccount), useValue: merchants },
        { provide: getRepositoryToken(TenantSetting), useValue: settings },
        { provide: DataSource, useValue: dataSource },
        { provide: StorageService, useValue: storage },
        {
          provide: ConfigService,
          useValue: createMockConfigService({
            EMAIL_ENABLED: 'true',
            EMAIL_PROVIDER: 'resend',
            RESEND_API_KEY: 're_super_secret_value',
            ...config,
          }),
        },
      ],
    }).compile();
    return moduleRef.get(SupportIntegrationService);
  };

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    merchants = createMockRepository();
    settings = createMockRepository();
    settings.findOne.mockResolvedValue({ id: 's1', bot_enabled: true });
    storage = { isConfigured: jest.fn(() => true) };
    dataSource = createMockDataSource();
    dataSource.query = routeQuery([
      [
        /FROM whatsapp_accounts/,
        [
          {
            id: 'wa1',
            display_phone_number: '+966 50 123 4567',
            verified_name: 'Bright Smile',
            waba_id: 'waba-1',
            meta_business_id: 'mb-1',
            connection_status: 'CONNECTED',
            is_active: true,
            is_default: true,
            has_credentials: true,
            connected_at: new Date('2026-01-01T00:00:00Z'),
            last_synced_at: new Date('2026-06-01T00:00:00Z'),
            token_expires_at: null,
          },
        ],
      ],
      [
        /FROM whatsapp_webhooks/,
        [
          {
            last_received_at: new Date('2026-08-01T10:00:00Z'),
            last_processed_at: new Date('2026-08-01T10:00:01Z'),
            unprocessed_last_7_days: 0,
            received_last_7_days: 42,
          },
        ],
      ],
      [
        /FROM notification_logs/,
        [
          {
            last_sent_at: new Date('2026-08-01T09:00:00Z'),
            last_failed_at: null,
            failed_last_7_days: 0,
            sent_last_7_days: 12,
            last_error: null,
          },
        ],
      ],
      [
        /FROM email_logs/,
        [
          {
            last_sent_at: new Date('2026-08-02T08:00:00Z'),
            last_failed_at: null,
            failed_last_7_days: 0,
            sent_last_7_days: 5,
            last_error: null,
          },
        ],
      ],
      [
        /FROM payments/,
        [
          {
            last_payment_at: new Date('2026-07-30T00:00:00Z'),
            last_paid_at: new Date('2026-07-30T00:01:00Z'),
            failed_last_7_days: 0,
            pending_last_7_days: 1,
          },
        ],
      ],
      [
        /FROM tenant_ai_deployments/,
        [
          {
            enabled: true,
            provider: 'openai',
            region: 'eu',
            has_dedicated_key: true,
            updated_at: new Date('2026-05-01T00:00:00Z'),
          },
        ],
      ],
      [
        /FROM ai_execution_metrics/,
        [
          {
            last_activity_at: new Date('2026-08-01T12:00:00Z'),
            failures_last_7_days: 0,
            executions_last_7_days: 340,
          },
        ],
      ],
    ]);
    merchants.findOne.mockResolvedValue({
      id: 'm1',
      status: 'APPROVED',
      provider: 'tap',
      submitted_at: new Date('2026-02-01T00:00:00Z'),
      approved_at: new Date('2026-02-05T00:00:00Z'),
    });

    service = await build();
  });

  it('returns one status block per integration plus a collection timestamp', async () => {
    const result = await service.overview(TENANT_ID);

    expect(Object.keys(result).sort()).toEqual(
      ['ai', 'checkedAt', 'email', 'payments', 'storage', 'whatsapp'].sort(),
    );
  });

  describe('secret exclusion', () => {
    it('never emits the Meta access token — only a hasCredentials boolean derived in SQL', async () => {
      const result = await service.whatsapp(TENANT_ID);

      expect(result.accounts[0].hasCredentials).toBe(true);
      expect(result.accounts[0]).not.toHaveProperty('accessToken');
      expect(result.accounts[0]).not.toHaveProperty('access_token');
      // The column is not even selected, so the value cannot reach the app.
      const [sql] = dataSource.query.mock.calls.find(([s]: [string]) =>
        /FROM whatsapp_accounts/.test(s),
      )!;
      expect(sql).toContain('access_token IS NOT NULL');
      expect(sql).not.toMatch(/SELECT[\s\S]*\bwa\.access_token\b\s*,/);
    });

    it('never emits the AI provider key — only hasDedicatedKey', async () => {
      const result = await service.ai(TENANT_ID);

      expect(result.hasDedicatedKey).toBe(true);
      expect(JSON.stringify(result)).not.toContain('api_key');
      expect(JSON.stringify(result)).not.toContain('ciphertext');
    });

    it('never emits the email provider API key — only whether one is configured', async () => {
      const result = await service.email(TENANT_ID);

      expect(result.providerConfigured).toBe(true);
      expect(JSON.stringify(result)).not.toContain('re_super_secret_value');
    });

    it('never emits bank details, recipient ids or the merchant status history', async () => {
      const result = await service.payments(TENANT_ID);

      expect(Object.keys(result).sort()).toEqual(
        [
          'approvedAt',
          'configured',
          'failedLast7Days',
          'health',
          'lastPaymentAt',
          'lastSuccessfulPaymentAt',
          'merchantStatus',
          'pendingLast7Days',
          'provider',
          'submittedAt',
        ].sort(),
      );
      const [args] = merchants.findOne.mock.calls[0];
      expect(args.select).not.toHaveProperty('iban_masked');
      expect(args.select).not.toHaveProperty('bank_name');
      expect(args.select).not.toHaveProperty('beneficiary_name');
      expect(args.select).not.toHaveProperty('provider_recipient_id');
      expect(args.select).not.toHaveProperty('status_history');
    });

    it('never selects the raw Meta webhook payload — private message content stays in the database', async () => {
      await service.whatsapp(TENANT_ID);

      const [sql] = dataSource.query.mock.calls.find(([s]: [string]) =>
        /FROM whatsapp_webhooks/.test(s),
      )!;
      expect(sql).not.toContain('payload');
    });

    it('reports no AI cost, token spend or pricing anywhere', async () => {
      const result = await service.ai(TENANT_ID);
      const serialized = JSON.stringify(result).toLowerCase();

      for (const forbidden of ['cost', 'usd', 'token', 'pricing', 'price']) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  describe('health states', () => {
    it('distinguishes not_configured from disconnected — a clinic that never connected is not broken', async () => {
      dataSource.query = routeQuery([
        [/FROM whatsapp_accounts/, []],
        [/FROM whatsapp_webhooks/, [{}]],
        [/FROM notification_logs/, [{}]],
      ]);
      service = await build();

      const result = await service.whatsapp(TENANT_ID);

      expect(result.health).toBe('not_configured');
      expect(result.accounts).toEqual([]);
    });

    it('reports disconnected when an account exists but Meta no longer considers it connected', async () => {
      dataSource.query = routeQuery([
        [
          /FROM whatsapp_accounts/,
          [
            {
              id: 'wa1',
              connection_status: 'DISCONNECTED',
              is_active: true,
              is_default: true,
              has_credentials: false,
              display_phone_number: null,
              verified_name: null,
              waba_id: null,
              meta_business_id: null,
              connected_at: null,
              last_synced_at: null,
              token_expires_at: null,
            },
          ],
        ],
        [/FROM whatsapp_webhooks/, [{}]],
        [/FROM notification_logs/, [{}]],
      ]);
      service = await build();

      expect((await service.whatsapp(TENANT_ID)).health).toBe('disconnected');
    });

    it('reports degraded when connected but recent sends are failing', async () => {
      dataSource.query = routeQuery([
        [
          /FROM whatsapp_accounts/,
          [
            {
              id: 'wa1',
              connection_status: 'CONNECTED',
              is_active: true,
              is_default: true,
              has_credentials: true,
              display_phone_number: '+966 50 000 0000',
              verified_name: null,
              waba_id: null,
              meta_business_id: null,
              connected_at: null,
              last_synced_at: null,
              token_expires_at: null,
            },
          ],
        ],
        [/FROM whatsapp_webhooks/, [{ unprocessed_last_7_days: 0, received_last_7_days: 1 }]],
        [
          /FROM notification_logs/,
          [
            {
              last_sent_at: null,
              last_failed_at: new Date('2026-08-01T00:00:00Z'),
              failed_last_7_days: 3,
              sent_last_7_days: 0,
              last_error: 'Meta rejected token https://graph.facebook.com/v21.0/x?access_token=EAAG',
            },
          ],
        ],
      ]);
      service = await build();

      const result = await service.whatsapp(TENANT_ID);

      expect(result.health).toBe('degraded');
      expect(result.traffic.failedLast7Days).toBe(3);
      // The provider error carried a URL with a token — both must be scrubbed.
      expect(result.traffic.lastFailureReason).not.toContain('EAAG');
      expect(result.traffic.lastFailureReason).not.toContain('graph.facebook.com');
    });

    it('reports email as not_configured when the platform provider is unset, regardless of clinic history', async () => {
      service = await build({ RESEND_API_KEY: '' });

      expect((await service.email(TENANT_ID)).health).toBe('not_configured');
    });

    it('reports payments as not_configured when the clinic has no merchant account at all', async () => {
      merchants.findOne.mockResolvedValue(null);

      const result = await service.payments(TENANT_ID);

      expect(result.health).toBe('not_configured');
      expect(result.configured).toBe(false);
      expect(result.merchantStatus).toBeNull();
    });

    it('separates the platform AI deployment switch from the clinic bot toggle', async () => {
      settings.findOne.mockResolvedValue({ id: 's1', bot_enabled: false });

      const result = await service.ai(TENANT_ID);

      expect(result.deploymentEnabled).toBe(true);
      expect(result.botEnabled).toBe(false);
    });

    it('marks the webhook unhealthy when events are arriving but not being processed', async () => {
      dataSource.query = routeQuery([
        [/FROM whatsapp_accounts/, []],
        [
          /FROM whatsapp_webhooks/,
          [
            {
              last_received_at: new Date('2026-08-01T00:00:00Z'),
              last_processed_at: null,
              unprocessed_last_7_days: 9,
              received_last_7_days: 9,
            },
          ],
        ],
        [/FROM notification_logs/, [{}]],
      ]);
      service = await build();

      const { webhook } = await service.whatsapp(TENANT_ID);

      expect(webhook.healthy).toBe(false);
      expect(webhook.unprocessedLast7Days).toBe(9);
    });
  });

  it('404s an unknown clinic before probing anything', async () => {
    tenants.exists.mockResolvedValue(false);

    await expect(service.overview(TENANT_ID)).rejects.toMatchObject({
      code: ErrorCode.TENANT_NOT_FOUND,
    });
  });
});

/**
 * The FOCUSED WhatsApp view (`platform.support.whatsapp.read_diagnostics`) —
 * separately gated from the integrations roll-up because a clinic's messaging
 * state is more sensitive than a configured/not-configured summary.
 */
describe('SupportIntegrationService — WhatsApp diagnostics', () => {
  let service: SupportIntegrationService;
  let tenants: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    dataSource = createMockDataSource();
    dataSource.query = jest.fn(async (sql: string) => {
      if (/FROM whatsapp_accounts/.test(sql)) {
        return [
          {
            id: 'wa1',
            display_phone_number: '+966 50 123 4567',
            verified_name: 'Bright Smile',
            waba_id: 'waba-1',
            meta_business_id: 'mb-1',
            connection_status: 'CONNECTED',
            is_active: true,
            is_default: true,
            has_credentials: true,
            connected_at: null,
            last_synced_at: null,
            token_expires_at: null,
          },
        ];
      }
      if (/FROM whatsapp_webhooks/.test(sql)) {
        return [
          {
            last_received_at: new Date('2026-07-20T00:00:00Z'),
            last_processed_at: new Date('2026-07-20T00:00:01Z'),
            unprocessed_last_7_days: 0,
            received_last_7_days: 0,
          },
        ];
      }
      if (/FROM whatsapp_templates/.test(sql)) {
        return [
          { status: 'APPROVED', count: 2 },
          { status: 'REJECTED', count: 3 },
        ];
      }
      // The two notification_logs probes are distinguished by their shape: the
      // failure list selects `error_message` directly, the traffic aggregate
      // uses ARRAY_AGG.
      if (/FROM notification_logs/.test(sql) && /SELECT created_at, error_message/.test(sql)) {
        return [
          {
            created_at: new Date('2026-08-01T00:00:00Z'),
            error_message:
              'Meta error 190: token expired — https://graph.facebook.com/v21.0/me?access_token=EAAGxyz',
          },
        ];
      }
      if (/FROM notification_logs/.test(sql)) {
        return [
          {
            last_sent_at: null,
            last_failed_at: new Date('2026-08-01T00:00:00Z'),
            failed_last_7_days: 5,
            sent_last_7_days: 0,
            last_error: 'Meta error 190: token expired',
          },
        ];
      }
      return [];
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportIntegrationService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(WhatsappAccount), useValue: createMockRepository() },
        { provide: getRepositoryToken(MerchantAccount), useValue: createMockRepository() },
        { provide: getRepositoryToken(TenantSetting), useValue: createMockRepository() },
        { provide: DataSource, useValue: dataSource },
        { provide: StorageService, useValue: { isConfigured: () => true } },
        { provide: ConfigService, useValue: createMockConfigService({}) },
      ],
    }).compile();

    service = moduleRef.get(SupportIntegrationService);
  });

  it('answers "WhatsApp messages stopped working" end to end without ever revealing the Meta token', async () => {
    const result = await service.whatsappDiagnostics(TENANT_ID);

    // Connected, so the clinic is not misdiagnosed as "never set up"…
    expect(result.health).toBe('degraded');
    expect(result.accounts[0].connectionStatus).toBe('CONNECTED');
    expect(result.accounts[0].displayPhoneNumber).toBe('+966 50 123 4567');
    // …and the actual cause is visible.
    expect(result.traffic.failedLast7Days).toBe(5);
    expect(result.recentFailures[0].reason).toContain('token expired');
    expect(result.templates).toEqual([
      { status: 'APPROVED', count: 2 },
      { status: 'REJECTED', count: 3 },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('EAAGxyz');
    expect(serialized).not.toContain('graph.facebook.com');
    expect(serialized).not.toContain('access_token');
  });

  it('returns recent failures as reason + timestamp only — no recipient, no message body', async () => {
    const { recentFailures } = await service.whatsappDiagnostics(TENANT_ID);

    expect(Object.keys(recentFailures[0]).sort()).toEqual(['at', 'reason']);
  });

  it('never selects the template body — components carry message content', async () => {
    await service.whatsappDiagnostics(TENANT_ID);

    const sql = dataSource.query.mock.calls.find(([s]: [string]) =>
      /FROM whatsapp_templates/.test(s),
    )![0] as string;
    expect(sql).not.toContain('components');
    expect(sql).not.toContain('body');
  });

  it('caps the recent-failure list so a broken integration cannot become a bulk export', async () => {
    await service.whatsappDiagnostics(TENANT_ID);

    const sql = dataSource.query.mock.calls.find(([s]: [string]) =>
      /SELECT created_at, error_message/.test(s),
    )![0] as string;
    expect(sql).toMatch(/LIMIT\s+10/);
  });

  it('404s an unknown clinic before probing', async () => {
    tenants.exists.mockResolvedValue(false);

    await expect(service.whatsappDiagnostics(TENANT_ID)).rejects.toMatchObject({
      code: ErrorCode.TENANT_NOT_FOUND,
    });
  });
});
