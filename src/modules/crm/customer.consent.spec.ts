import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  CUSTOMER_CONSENT_AUDIT_ACTION,
  CustomerService,
} from './customer.service';
import { Customer } from '../../entities/CRM/Customer';
import { StaffScopeService } from '../../core/staff-scope/staff-scope.service';
import { UsageService } from '../subscription-billing/usage.service';
import { ActivityAuditService } from '../activity-log/activity-audit.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const ACTOR = 'user-1';

/**
 * Marketing consent: WHEN and HOW it was given, who changed it, and that an
 * opt-out keyword also withdraws it. The decision to send is unchanged (it still
 * reads `marketing_opt_in` / `opted_out_at`); this is the record behind it.
 */
describe('CustomerService — consent provenance', () => {
  let service: CustomerService;
  let customers: MockRepository;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    customers = createMockRepository();
    (customers as unknown as { manager: unknown }).manager = {
      transaction: jest.fn(async (work: (m: unknown) => unknown) =>
        work({ query: jest.fn(), getRepository: () => customers }),
      ),
    };
    // `save` echoes what it was given, like TypeORM does.
    customers.save.mockImplementation((c: unknown) =>
      Promise.resolve({ id: 'cust-1', ...(c as object) }),
    );
    customers.count.mockResolvedValue(0);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerService,
        { provide: getRepositoryToken(Customer), useValue: customers },
        {
          provide: UsageService,
          useValue: { assertResourceWithinLimit: jest.fn() },
        },
        { provide: StaffScopeService, useValue: {} },
        { provide: ActivityAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(CustomerService);
  });

  afterEach(() => jest.clearAllMocks());

  const base = { full_name: 'Test Patient', phone: '+966500000001' };

  describe('create', () => {
    it('stamps date and source when the patient is created already opted in', async () => {
      const before = Date.now();
      const saved = await service.create(
        TENANT,
        { ...base, marketing_opt_in: true } as never,
        {
          actorUserId: ACTOR,
        },
      );
      expect(saved.marketing_opt_in_at!.getTime()).toBeGreaterThanOrEqual(
        before,
      );
      expect(saved.marketing_opt_in_source).toBe('staff');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          action: CUSTOMER_CONSENT_AUDIT_ACTION,
          actorUserId: ACTOR,
          before: { marketingOptIn: false },
          after: { marketingOptIn: true, source: 'staff' },
        }),
      );
    });

    it('records the channel: an import is an "import", not a staff entry', async () => {
      const saved = await service.create(
        TENANT,
        { ...base, marketing_opt_in: true } as never,
        {
          source: 'import',
        },
      );
      expect(saved.marketing_opt_in_source).toBe('import');
    });

    it('records nothing when consent was not given (it defaults to false)', async () => {
      const saved = await service.create(TENANT, base as never);
      expect(saved.marketing_opt_in).toBe(false);
      expect(saved.marketing_opt_in_at).toBeUndefined();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('never puts contact details in the audit row', async () => {
      await service.create(TENANT, {
        ...base,
        email: 'x@y.com',
        marketing_opt_in: true,
      } as never);
      const serialised = JSON.stringify(audit.record.mock.calls);
      expect(serialised).not.toContain('+966500000001');
      expect(serialised).not.toContain('x@y.com');
    });
  });

  describe('update', () => {
    const existing = (optIn: boolean) => ({
      id: 'cust-1',
      tenant: { id: TENANT },
      phone: '+966500000001',
      marketing_opt_in: optIn,
      marketing_opt_in_at: optIn ? new Date('2026-01-01T00:00:00Z') : null,
      marketing_opt_in_source: optIn ? 'import' : null,
    });

    it('stamps a new grant and audits false → true', async () => {
      customers.findOne.mockResolvedValueOnce(existing(false));
      const saved = await service.update(
        TENANT,
        'cust-1',
        { marketing_opt_in: true } as never,
        {
          actorUserId: ACTOR,
        },
      );
      expect(saved.marketing_opt_in_at).toBeInstanceOf(Date);
      expect(saved.marketing_opt_in_source).toBe('staff');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: ACTOR,
          before: { marketingOptIn: false },
          after: { marketingOptIn: true, source: 'staff' },
        }),
      );
    });

    it('a withdrawal audits true → false and keeps the date of the original grant', async () => {
      customers.findOne.mockResolvedValueOnce(existing(true));
      const saved = await service.update(
        TENANT,
        'cust-1',
        { marketing_opt_in: false } as never,
        {
          actorUserId: ACTOR,
        },
      );
      expect(saved.marketing_opt_in).toBe(false);
      expect(saved.marketing_opt_in_at).toEqual(
        new Date('2026-01-01T00:00:00Z'),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          before: { marketingOptIn: true },
          after: expect.objectContaining({ marketingOptIn: false }),
        }),
      );
    });

    it('does not touch the record or the audit trail when consent did not change', async () => {
      customers.findOne.mockResolvedValueOnce(existing(true));
      const saved = await service.update(TENANT, 'cust-1', {
        marketing_opt_in: true,
      } as never);
      expect(saved.marketing_opt_in_at).toEqual(
        new Date('2026-01-01T00:00:00Z'),
      );
      expect(saved.marketing_opt_in_source).toBe('import');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an unrelated edit leaves consent alone', async () => {
      customers.findOne.mockResolvedValueOnce(existing(true));
      await service.update(TENANT, 'cust-1', {
        full_name: 'New Name',
      } as never);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('recordOptOut — an opt-out keyword withdraws marketing consent too', () => {
    it('sets opted_out_at AND clears marketing_opt_in, scoped to the tenant', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'cust-1',
        marketing_opt_in: true,
      });
      await service.recordOptOut(TENANT, 'cust-1', 'inbound_keyword');

      expect(customers.update).toHaveBeenCalledWith(
        { id: 'cust-1', tenant: { id: TENANT } },
        expect.objectContaining({
          opt_out_source: 'inbound_keyword',
          marketing_opt_in: false,
          opted_out_at: expect.any(Date),
        }),
      );
    });

    it('audits the withdrawal with its channel when consent was on', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'cust-1',
        marketing_opt_in: true,
      });
      await service.recordOptOut(TENANT, 'cust-1', 'inbound_keyword');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          action: CUSTOMER_CONSENT_AUDIT_ACTION,
          before: { marketingOptIn: true },
          after: { marketingOptIn: false, source: 'inbound_keyword' },
        }),
      );
    });

    it('does not write an audit row for someone who never had consent', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'cust-1',
        marketing_opt_in: false,
      });
      await service.recordOptOut(TENANT, 'cust-1', 'inbound_keyword');
      expect(audit.record).not.toHaveBeenCalled();
      // The opt-out itself is still recorded.
      expect(customers.update).toHaveBeenCalled();
    });
  });
});
