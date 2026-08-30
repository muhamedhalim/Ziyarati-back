import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { UnsubscribeService } from './unsubscribe.service';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Customer } from '../../entities/CRM/Customer';
import { UnsubscribeTokenService } from './unsubscribe-token.service';
import { EmailSuppressionService } from './email-suppression.service';
import { CampaignAuditService } from '../campaigns/campaign-audit.service';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('UnsubscribeService', () => {
  let service: UnsubscribeService;
  let tenants: MockRepository;
  let customers: MockRepository;
  let tokens: { verify: jest.Mock };
  let suppression: { isSuppressed: jest.Mock; suppress: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    tenants = createMockRepository();
    customers = createMockRepository();
    tokens = { verify: jest.fn() };
    suppression = {
      isSuppressed: jest.fn(),
      suppress: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UnsubscribeService,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: UnsubscribeTokenService, useValue: tokens },
        { provide: EmailSuppressionService, useValue: suppression },
        { provide: CampaignAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(UnsubscribeService);
  });

  describe('resolve', () => {
    it('returns null for an unknown/invalid token (never distinguished from other refusals)', async () => {
      tokens.verify.mockReturnValueOnce(null);
      await expect(service.resolve('bad-token')).resolves.toBeNull();
      expect(tenants.findOne).not.toHaveBeenCalled();
    });

    it('returns null when the token names a tenant that no longer exists', async () => {
      tokens.verify.mockReturnValueOnce({ tenantId: 't1', email: 'a@b.com' });
      tenants.findOne.mockResolvedValueOnce(null);
      await expect(service.resolve('tok')).resolves.toBeNull();
    });

    it('returns the clinic name and a MASKED email — never the raw address', async () => {
      tokens.verify.mockReturnValueOnce({
        tenantId: 't1',
        email: 'patient@example.com',
      });
      tenants.findOne.mockResolvedValueOnce({
        id: 't1',
        name: 'Sunrise Clinic',
      });
      suppression.isSuppressed.mockResolvedValueOnce(false);

      const result = await service.resolve('tok');

      expect(result).toMatchObject({
        clinicName: 'Sunrise Clinic',
        alreadyUnsubscribed: false,
      });
      expect(result?.email).not.toBe('patient@example.com');
      expect(result?.email).toContain('@example.com');
      expect(result?.email).toContain('***');
    });

    it('reports alreadyUnsubscribed=true when a suppression already exists (idempotent GET)', async () => {
      tokens.verify.mockReturnValueOnce({ tenantId: 't1', email: 'a@b.com' });
      tenants.findOne.mockResolvedValueOnce({ id: 't1', name: 'Clinic' });
      suppression.isSuppressed.mockResolvedValueOnce(true);

      await expect(service.resolve('tok')).resolves.toMatchObject({
        alreadyUnsubscribed: true,
      });
    });
  });

  describe('confirm', () => {
    it('returns null for an unknown token, writing nothing', async () => {
      tokens.verify.mockReturnValueOnce(null);
      await expect(service.confirm('bad')).resolves.toBeNull();
      expect(suppression.suppress).not.toHaveBeenCalled();
    });

    it('writes the suppression, clears matching customer flags, and records an audit row with no address', async () => {
      tokens.verify.mockReturnValueOnce({
        tenantId: 't1',
        email: 'patient@example.com',
      });
      tenants.findOne.mockResolvedValueOnce({ id: 't1', name: 'Clinic' });
      const qb = createMockQueryBuilder();
      customers.createQueryBuilder.mockReturnValue(qb);

      const result = await service.confirm('tok');

      expect(result).toEqual({ unsubscribed: true });
      expect(suppression.suppress).toHaveBeenCalledWith(
        't1',
        'patient@example.com',
        'UNSUBSCRIBE',
        'unsubscribe_link',
      );
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ marketing_opt_in: false }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        'campaign.unsubscribed',
        't1',
        undefined,
        expect.not.objectContaining({ email: expect.anything() }),
      );
      // T139 — no recipient address anywhere in the audit payload.
      const auditDetails = audit.record.mock.calls[0][3];
      expect(JSON.stringify(auditDetails)).not.toContain('patient@example.com');
    });

    it('is idempotent — calling confirm twice for the same token never errors (EmailSuppressionService itself guarantees the no-op)', async () => {
      tokens.verify.mockReturnValue({ tenantId: 't1', email: 'a@b.com' });
      tenants.findOne.mockResolvedValue({ id: 't1', name: 'Clinic' });
      customers.createQueryBuilder.mockReturnValue(createMockQueryBuilder());

      await expect(service.confirm('tok')).resolves.toEqual({
        unsubscribed: true,
      });
      await expect(service.confirm('tok')).resolves.toEqual({
        unsubscribed: true,
      });
      expect(suppression.suppress).toHaveBeenCalledTimes(2);
    });
  });
});
