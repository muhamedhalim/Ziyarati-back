import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookAuditService, WEBHOOK_AUDIT_ACTION } from './webhook-audit.service';
import { WebhookEndpoint } from '../../entities/System/WebhookEndpoint';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('WebhookEndpointService', () => {
  let service: WebhookEndpointService;
  let endpoints: MockRepository;
  let audit: { record: jest.Mock };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };

  beforeEach(async () => {
    endpoints = createMockRepository();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    encryption = {
      encrypt: jest.fn((s: string) => `enc:${s}`),
      decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEndpointService,
        { provide: getRepositoryToken(WebhookEndpoint), useValue: endpoints },
        { provide: EncryptionService, useValue: encryption },
        { provide: WebhookAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(WebhookEndpointService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('rejects an unsafe (SSRF) URL before ever touching the repository', async () => {
      await expect(
        service.create(TENANT, { url: 'http://127.0.0.1/hook', events: ['appointment.created'] } as any, {}),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(endpoints.save).not.toHaveBeenCalled();
    });

    it('rejects when no valid event survives normalization', async () => {
      await expect(
        service.create(TENANT, { url: 'https://example.com/hook', events: ['bogus.event'] } as any, {}),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('encrypts the secret, stores a safe prefix, and returns the plaintext once', async () => {
      endpoints.save.mockImplementationOnce(async (e: any) => ({ ...e, id: 'e1' }));
      const res = await service.create(
        TENANT,
        { name: 'ERP', url: 'https://example.com/hook', events: ['appointment.created'] } as any,
        { userId: 'u1', ip: '1.2.3.4' },
      );
      expect(res.secret).toEqual(expect.any(String));
      expect((res as Record<string, unknown>).secret_ciphertext).toBeUndefined();
      expect(encryption.encrypt).toHaveBeenCalledWith(res.secret);
      const saved = endpoints.save.mock.calls[0][0];
      expect(saved.secret_ciphertext).toBe(`enc:${res.secret}`);
      expect(saved.secret_prefix).toBeDefined();
      expect(res.secret.startsWith(saved.secret_prefix)).toBe(true);
    });

    it('records an audit row on create, never containing the plaintext secret', async () => {
      endpoints.save.mockImplementationOnce(async (e: any) => ({ ...e, id: 'e1' }));
      const res = await service.create(
        TENANT,
        { name: 'ERP', url: 'https://example.com/hook', events: ['appointment.created'] } as any,
        { userId: 'u1' },
      );
      expect(audit.record).toHaveBeenCalledWith(
        WEBHOOK_AUDIT_ACTION.CREATE,
        TENANT,
        'u1',
        'WebhookEndpoint',
        'e1',
        undefined,
        expect.objectContaining({ name: 'ERP', events: ['appointment.created'] }),
      );
      const details = audit.record.mock.calls[0][6];
      expect(JSON.stringify(details)).not.toContain(res.secret);
    });
  });

  describe('rotateSecret', () => {
    it('issues a new secret + prefix and audits it', async () => {
      endpoints.findOne.mockResolvedValueOnce({
        id: 'e1',
        secret_ciphertext: 'enc:old',
        secret_prefix: 'whsec_old',
      });
      endpoints.save.mockImplementationOnce(async (e: any) => e);
      const res = await service.rotateSecret(TENANT, 'e1', { userId: 'u1' });
      expect(res.secret_prefix).not.toBe('whsec_old');
      expect(res.secret.startsWith(res.secret_prefix!)).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        WEBHOOK_AUDIT_ACTION.ROTATE_SECRET,
        TENANT,
        'u1',
        'WebhookEndpoint',
        'e1',
        undefined,
      );
    });
  });

  describe('setActive', () => {
    it('toggles is_active and audits ENABLE/DISABLE distinctly', async () => {
      endpoints.findOne.mockResolvedValue({ id: 'e1', is_active: false });
      endpoints.save.mockImplementation(async (e: any) => e);
      expect((await service.setActive(TENANT, 'e1', true, { userId: 'u1' })).is_active).toBe(true);
      expect((await service.setActive(TENANT, 'e1', false, { userId: 'u1' })).is_active).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        WEBHOOK_AUDIT_ACTION.ENABLE,
        TENANT,
        'u1',
        'WebhookEndpoint',
        'e1',
        undefined,
      );
      expect(audit.record).toHaveBeenCalledWith(
        WEBHOOK_AUDIT_ACTION.DISABLE,
        TENANT,
        'u1',
        'WebhookEndpoint',
        'e1',
        undefined,
      );
    });
  });

  describe('remove', () => {
    it('audits the deletion and removes the row (cascade handles delivery history at the DB level)', async () => {
      endpoints.findOne.mockResolvedValueOnce({ id: 'e1', name: 'ERP', url: 'https://example.com/hook' });
      await service.remove(TENANT, 'e1', { userId: 'u1' });
      expect(endpoints.remove).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        WEBHOOK_AUDIT_ACTION.DELETE,
        TENANT,
        'u1',
        'WebhookEndpoint',
        'e1',
        undefined,
        expect.objectContaining({ name: 'ERP' }),
      );
    });
  });

  describe('cross-tenant isolation', () => {
    it('get() 404s for a key not owned by the tenant', async () => {
      endpoints.findOne.mockResolvedValueOnce(null);
      await expect(service.get(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('findActiveWithSecret', () => {
    it('returns null for an inactive endpoint (never decrypts a disabled endpoint\'s secret)', async () => {
      endpoints.findOne.mockResolvedValueOnce({ id: 'e1', is_active: false, secret_ciphertext: 'enc:x' });
      expect(await service.findActiveWithSecret('e1')).toBeNull();
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it('returns the decrypted secret for an active endpoint', async () => {
      endpoints.findOne.mockResolvedValueOnce({ id: 'e1', is_active: true, secret_ciphertext: 'enc:plain' });
      const result = await service.findActiveWithSecret('e1');
      expect(result?.secret).toBe('plain');
    });
  });

  describe('findActiveSubscribers', () => {
    it('filters to endpoints subscribed to the given event type (active only, via repository query)', async () => {
      endpoints.find.mockResolvedValueOnce([
        { id: 'e1', is_active: true, events: ['appointment.created'] },
        { id: 'e2', is_active: true, events: ['payment.succeeded'] },
      ]);
      const subs = await service.findActiveSubscribers(TENANT, 'appointment.created');
      expect(subs.map((e) => e.id)).toEqual(['e1']);
    });
  });
});
