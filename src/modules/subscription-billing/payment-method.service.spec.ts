import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentMethodService } from './payment-method.service';
import {
  PAYMENT_PROVIDER,
  type SavedPaymentMethodInfo,
} from './payment/payment-provider.interface';
import {
  PAYMENT_METHOD_STATUS,
  TenantPaymentMethod,
} from '../../entities/SaaS-Core/TenantPaymentMethod';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockQueryBuilder,
  MockRepository,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';

const row = (over: Partial<TenantPaymentMethod> = {}): TenantPaymentMethod =>
  ({
    id: 'pm-1',
    tenant_id: TENANT,
    provider: 'tap',
    provider_customer_id: 'cus_1',
    provider_card_id: 'card_1',
    provider_payment_agreement_id: 'agr_1',
    brand: 'VISA',
    scheme: 'VISA',
    last_four: '1019',
    recurring_capable: true,
    is_default: true,
    status: PAYMENT_METHOD_STATUS.ACTIVE,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    revoked_at: null,
    ...over,
  }) as TenantPaymentMethod;

const info = (
  over: Partial<SavedPaymentMethodInfo> = {},
): SavedPaymentMethodInfo => ({
  provider: 'tap',
  customerId: 'cus_2',
  cardId: 'card_2',
  agreementId: 'agr_2',
  brand: 'MASTERCARD',
  scheme: 'MASTERCARD',
  lastFour: '0008',
  recurringCapable: true,
  ...over,
});

describe('PaymentMethodService', () => {
  let service: PaymentMethodService;
  let methods: MockRepository;
  let payment: { deletePaymentMethod: jest.Mock };

  beforeEach(async () => {
    methods = createMockRepository();
    payment = { deletePaymentMethod: jest.fn().mockResolvedValue(true) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentMethodService,
        { provide: getRepositoryToken(TenantPaymentMethod), useValue: methods },
        { provide: PAYMENT_PROVIDER, useValue: payment },
      ],
    }).compile();
    service = moduleRef.get(PaymentMethodService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getDefault / toView', () => {
    it('is scoped to the tenant, the ACTIVE default only', async () => {
      methods.findOne.mockResolvedValueOnce(row());
      await service.getDefault(TENANT);
      expect(methods.findOne).toHaveBeenCalledWith({
        where: { tenant_id: TENANT, is_default: true, status: 'ACTIVE' },
      });
    });

    it('returns display facts only — NEVER the provider ids', async () => {
      methods.findOne.mockResolvedValueOnce(row());
      const view = await service.getDefault(TENANT);
      expect(view).toEqual({
        id: 'pm-1',
        provider: 'tap',
        brand: 'VISA',
        scheme: 'VISA',
        lastFour: '1019',
        recurringCapable: true,
        isDefault: true,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      const text = JSON.stringify(view);
      for (const secret of ['cus_1', 'card_1', 'agr_1']) {
        expect(text).not.toContain(secret);
      }
    });

    it('is null when the clinic has no saved card', async () => {
      expect(await service.getDefault(TENANT)).toBeNull();
    });
  });

  describe('resolveForCharge', () => {
    it('returns the provider ids a merchant-initiated charge needs, plus our id for the invoice record', async () => {
      methods.findOne.mockResolvedValueOnce(row());
      expect(await service.resolveForCharge(TENANT)).toEqual({
        id: 'pm-1',
        ref: { customerId: 'cus_1', cardId: 'card_1', agreementId: 'agr_1' },
      });
    });

    it('a card whose scheme cannot be charged without the clinic present is NOT returned', async () => {
      methods.findOne.mockResolvedValueOnce(row({ recurring_capable: false }));
      expect(await service.resolveForCharge(TENANT)).toBeNull();
    });

    it('is null with no saved card', async () => {
      expect(await service.resolveForCharge(TENANT)).toBeNull();
    });
  });

  describe('upsertDefault (runs inside the settle transaction)', () => {
    let manager: MockEntityManager;
    let repo: MockRepository;
    let demoteQb: ReturnType<typeof createMockQueryBuilder>;

    beforeEach(() => {
      manager = createMockEntityManager();
      repo = manager.getRepository(
        TenantPaymentMethod,
      ) as unknown as MockRepository;
      demoteQb = createMockQueryBuilder();
      repo.createQueryBuilder.mockReturnValue(demoteQb);
      repo.save.mockImplementation(async (e: any) => ({
        id: e.id ?? 'pm-new',
        ...e,
      }));
    });

    it('inserts a new card as the ACTIVE default, after demoting the current default (the partial unique index allows one)', async () => {
      const order: string[] = [];
      demoteQb.execute.mockImplementation(async () => {
        order.push('demote');
        return { affected: 1 };
      });
      repo.save.mockImplementation(async (e: any) => {
        order.push('save');
        return { id: 'pm-new', ...e };
      });

      const saved = await service.upsertDefault(
        manager as never,
        TENANT,
        info(),
        'inv-1',
      );

      expect(order).toEqual(['demote', 'save']);
      expect(saved).toMatchObject({
        id: 'pm-new',
        tenant_id: TENANT,
        provider_card_id: 'card_2',
        provider_customer_id: 'cus_2',
        provider_payment_agreement_id: 'agr_2',
        brand: 'MASTERCARD',
        last_four: '0008',
        recurring_capable: true,
        is_default: true,
        status: 'ACTIVE',
        source_invoice_id: 'inv-1',
      });
      expect(demoteQb.set).toHaveBeenCalledWith({ is_default: false });
      expect(demoteQb.where).toHaveBeenCalledWith('tenant_id = :tenantId', {
        tenantId: TENANT,
      });
    });

    it('re-saving the SAME card refreshes it in place (no duplicate row) and revives a revoked one', async () => {
      const revoked = row({
        provider_card_id: 'card_2',
        status: PAYMENT_METHOD_STATUS.REVOKED,
        is_default: false,
        revoked_at: new Date(),
      });
      repo.findOne.mockResolvedValueOnce(revoked);

      await service.upsertDefault(manager as never, TENANT, info(), 'inv-2');

      expect(repo.create).not.toHaveBeenCalled();
      expect(revoked).toMatchObject({
        status: 'ACTIVE',
        is_default: true,
        revoked_at: null,
        provider_payment_agreement_id: 'agr_2',
      });
      expect(repo.save).toHaveBeenCalledWith(revoked);
    });

    it('NEVER re-attaches a card that already belongs to ANOTHER tenant — logged, skipped, nothing written', async () => {
      repo.findOne.mockResolvedValueOnce(
        row({ tenant_id: 'someone-else', provider_card_id: 'card_2' }),
      );
      const res = await service.upsertDefault(
        manager as never,
        TENANT,
        info(),
        'inv-3',
      );
      expect(res).toBeNull();
      expect(repo.save).not.toHaveBeenCalled();
      expect(demoteQb.execute).not.toHaveBeenCalled();
    });

    it('records a card that cannot be charged without the payer as not recurring-capable', async () => {
      const saved = await service.upsertDefault(
        manager as never,
        TENANT,
        info({ recurringCapable: false, scheme: 'KNET' }),
        'inv-4',
      );
      expect(saved?.recurring_capable).toBe(false);
    });
  });

  describe('remove', () => {
    it('revokes locally FIRST, then deletes at the provider', async () => {
      const m = row();
      methods.findOne.mockResolvedValueOnce(m);
      const order: string[] = [];
      methods.save.mockImplementation(async (e: any) => {
        order.push(`save:${e.status}`);
        return e;
      });
      payment.deletePaymentMethod.mockImplementation(async () => {
        order.push('provider-delete');
        return true;
      });

      const res = await service.remove(TENANT, 'pm-1');

      expect(order).toEqual(['save:REVOKED', 'provider-delete']);
      expect(m).toMatchObject({ status: 'REVOKED', is_default: false });
      expect(m.revoked_at).toBeInstanceOf(Date);
      expect(payment.deletePaymentMethod).toHaveBeenCalledWith({
        customerId: 'cus_1',
        cardId: 'card_1',
        agreementId: 'agr_1',
      });
      expect(res).toEqual({ removed: true, providerDeleted: true });
    });

    it("is tenant-scoped: another tenant's method is a plain 404", async () => {
      methods.findOne.mockResolvedValueOnce(null);
      await expect(service.remove(TENANT, 'pm-x')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(methods.findOne).toHaveBeenCalledWith({
        where: { id: 'pm-x', tenant_id: TENANT },
      });
      expect(payment.deletePaymentMethod).not.toHaveBeenCalled();
    });

    it('removing an already-revoked card is idempotent and does not call the provider again', async () => {
      methods.findOne.mockResolvedValueOnce(
        row({ status: PAYMENT_METHOD_STATUS.REVOKED }),
      );
      expect(await service.remove(TENANT, 'pm-1')).toEqual({
        removed: true,
        providerDeleted: false,
      });
      expect(payment.deletePaymentMethod).not.toHaveBeenCalled();
      expect(methods.save).not.toHaveBeenCalled();
    });

    it('a provider that cannot confirm the delete does NOT keep the card usable — it is revoked and the gap is reported', async () => {
      const m = row();
      methods.findOne.mockResolvedValueOnce(m);
      payment.deletePaymentMethod.mockResolvedValueOnce(false);
      const res = await service.remove(TENANT, 'pm-1');
      expect(m.status).toBe('REVOKED');
      expect(res).toEqual({ removed: true, providerDeleted: false });
    });

    it('a provider that throws does not undo the local revoke', async () => {
      const m = row();
      methods.findOne.mockResolvedValueOnce(m);
      payment.deletePaymentMethod.mockRejectedValueOnce(new Error('network'));
      const res = await service.remove(TENANT, 'pm-1');
      expect(m.status).toBe('REVOKED');
      expect(res.providerDeleted).toBe(false);
    });
  });
});
