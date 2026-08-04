import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentGatewayService } from './payment-gateway.service';
import { PaymentGateway } from '../../entities/Payments/PaymentGateway';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

describe('PaymentGatewayService', () => {
  let service: PaymentGatewayService;
  let gateways: MockRepository;
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };

  beforeEach(async () => {
    gateways = createMockRepository();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = { getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentGatewayService,
        { provide: getRepositoryToken(PaymentGateway), useValue: gateways },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(PaymentGatewayService);
  });

  afterEach(() => jest.clearAllMocks());

  it('get throws NOT_FOUND for an unknown gateway', async () => {
    gateways.findOne.mockResolvedValueOnce(null);
    await expect(service.get('x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  // FND-015 — create/update previously wrote NO audit entry and captured no actor.
  describe('FND-015 — audit trail', () => {
    it('audits a successful create with the acting super admin, WITHOUT leaking `config`', async () => {
      gateways.save.mockResolvedValueOnce({
        id: 'gw1',
        gateway_name: 'moyasar',
        is_active: true,
        config: { publicId: 'pub_123', liveSecretLookingField: 'sk_live_should_never_be_here' },
      });

      await service.create({
        gatewayName: 'moyasar',
        isActive: true,
        config: { publicId: 'pub_123', liveSecretLookingField: 'sk_live_should_never_be_here' },
      } as any);

      expect(audit.record).toHaveBeenCalledTimes(1);
      const call = audit.record.mock.calls[0][0];
      expect(call).toMatchObject({
        action: 'platform_admin.payment_gateway.create',
        userId: 'super-admin-1',
        entityType: 'payment_gateway',
        entityId: 'gw1',
        before: null,
        after: { gatewayName: 'moyasar', isActive: true, hasConfig: true },
      });
      // The raw config object (and anything it might contain) must never appear.
      expect(JSON.stringify(call)).not.toContain('sk_live_should_never_be_here');
    });

    it('audits a successful update with the before and after activation state', async () => {
      gateways.findOne.mockResolvedValueOnce({
        id: 'gw1',
        gateway_name: 'moyasar',
        is_active: true,
        config: null,
      });
      gateways.save.mockImplementationOnce(async (g: any) => g);

      await service.update('gw1', { isActive: false } as any);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.payment_gateway.update',
          userId: 'super-admin-1',
          entityType: 'payment_gateway',
          entityId: 'gw1',
          before: { gatewayName: 'moyasar', isActive: true, hasConfig: false },
          after: { gatewayName: 'moyasar', isActive: false, hasConfig: false },
        }),
      );
    });
  });
});
