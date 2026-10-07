import { PaymentLinkService } from './payment-link.service';
import { PAYMENT_LINK_STATUS } from './payments.constants';
import { PaymentLink } from '../../entities/Payments/PaymentLink';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const TOKEN = 'T'.repeat(32);

const servedConfig = {
  patientPayPageServed: true,
  payLinkUrl: (t: string) => `https://app.test/pay/${encodeURIComponent(t)}`,
};

function build(config: Record<string, unknown> = servedConfig) {
  const links: MockRepository = createMockRepository();
  const service = new PaymentLinkService(
    links as never,
    createMockRepository() as never,
    {} as never,
    {} as never,
    {} as never,
    config as never,
  );
  return { service, links };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  link_token: TOKEN,
  status: PAYMENT_LINK_STATUS.ACTIVE,
  amount: 250,
  expires_at: new Date(Date.now() + 3_600_000),
  tenant: { id: TENANT },
  appointment: { id: 'appt-1' },
  ...over,
});

describe('PaymentLinkService — the patient-facing additions (Tap Phase 4)', () => {
  describe('payUrlFor / toView', () => {
    it('payUrlFor is the durable public page, built by the payments module', () => {
      const { service } = build();
      expect(service.payUrlFor('abc')).toBe('https://app.test/pay/abc');
    });

    it('toView adds pay_url to a link tied to a booking', () => {
      const { service } = build();
      const view = service.toView(row({ appointment: 'appt-1' }) as never);
      expect(view.pay_url).toBe(`https://app.test/pay/${TOKEN}`);
      expect(view.link_token).toBe(TOKEN);
    });

    it('NO URL is issued where the deployment cannot complete a patient payment on the page (a non-Tap provider in production) — a patient is never handed a dead link', () => {
      const { service } = build({
        ...servedConfig,
        patientPayPageServed: false,
      });
      expect(service.payUrlFor('abc')).toBeUndefined();
      expect(
        service.toView(row({ appointment: 'appt-1' }) as never),
      ).not.toHaveProperty('pay_url');
    });

    it('toView offers NO pay_url for an amount-only link — the public page prices from the appointment, so it could never take that money', () => {
      const { service } = build();
      const view = service.toView(row({ appointment: undefined }) as never);
      expect(view).not.toHaveProperty('pay_url');
    });
  });

  describe('findPublicByToken', () => {
    it.each([
      [''],
      ['short'],
      ['has spaces in it........................'],
      ['../../etc/passwd/xxxxxxxxxxxxxxx'],
      ['x'.repeat(65)],
      [undefined as never],
      [{} as never],
    ])('never queries for a malformed token (%p)', async (bad) => {
      const { service, links } = build();
      expect(await service.findPublicByToken(bad)).toBeNull();
      expect(links.findOne).not.toHaveBeenCalled();
    });

    it('looks the link up by token ALONE — the token is the credential, there is no tenant to filter on', async () => {
      const { service, links } = build();
      links.findOne.mockResolvedValueOnce(row());
      await service.findPublicByToken(TOKEN);
      expect(links.findOne.mock.calls[0][0]).toMatchObject({
        where: { link_token: TOKEN },
      });
    });

    it('returns a plain ref (ids + status), never the entity', async () => {
      const { service, links } = build();
      const expires = new Date(Date.now() + 3_600_000);
      links.findOne.mockResolvedValueOnce(row({ expires_at: expires }));
      expect(await service.findPublicByToken(TOKEN)).toEqual({
        linkId: 'l1',
        tenantId: TENANT,
        appointmentId: 'appt-1',
        status: 'ACTIVE',
        expiresAt: expires,
      });
    });

    it('null for an unknown token', async () => {
      const { service, links } = build();
      links.findOne.mockResolvedValueOnce(null);
      expect(await service.findPublicByToken(TOKEN)).toBeNull();
    });

    it('null for a link with no appointment — the booking pay surface cannot pay it', async () => {
      const { service, links } = build();
      links.findOne.mockResolvedValueOnce(row({ appointment: null }));
      expect(await service.findPublicByToken(TOKEN)).toBeNull();
    });

    it('lazily flips an expired ACTIVE link to EXPIRED (a column UPDATE) and reports it expired', async () => {
      const { service, links } = build();
      links.findOne.mockResolvedValueOnce(
        row({ expires_at: new Date(Date.now() - 1000) }),
      );
      const out = await service.findPublicByToken(TOKEN);
      expect(out?.status).toBe(PAYMENT_LINK_STATUS.EXPIRED);
      expect(links.update).toHaveBeenCalledWith('l1', {
        status: PAYMENT_LINK_STATUS.EXPIRED,
      });
    });

    it('leaves USED / DISABLED links exactly as they are', async () => {
      const { service, links } = build();
      links.findOne.mockResolvedValueOnce(
        row({ status: PAYMENT_LINK_STATUS.USED, expires_at: new Date(0) }),
      );
      expect((await service.findPublicByToken(TOKEN))?.status).toBe(
        PAYMENT_LINK_STATUS.USED,
      );
      links.findOne.mockResolvedValueOnce(
        row({ status: PAYMENT_LINK_STATUS.DISABLED }),
      );
      expect((await service.findPublicByToken(TOKEN))?.status).toBe(
        PAYMENT_LINK_STATUS.DISABLED,
      );
      expect(links.update).not.toHaveBeenCalled();
    });
  });

  describe('markUsedForAppointment', () => {
    it("spends only ACTIVE links of THIS tenant's appointment, and reports how many moved", async () => {
      const { service, links } = build();
      const qb = createMockQueryBuilder();
      links.createQueryBuilder.mockReturnValue(qb);
      qb.execute.mockResolvedValueOnce({ affected: 2 });

      expect(await service.markUsedForAppointment(TENANT, 'appt-1')).toBe(2);

      expect(qb.update).toHaveBeenCalledWith(PaymentLink);
      expect(qb.set).toHaveBeenCalledWith({ status: PAYMENT_LINK_STATUS.USED });
      const wheres = [qb.where.mock.calls, qb.andWhere.mock.calls]
        .flat()
        .map((c) => String(c[0]));
      expect(wheres.join(' ')).toContain('"appointmentId" = :appointmentId');
      expect(wheres.join(' ')).toContain('"tenantId" = :tenantId');
      expect(wheres.join(' ')).toContain('status = :active');
      const params = [...qb.where.mock.calls, ...qb.andWhere.mock.calls].map(
        (c) => c[1],
      );
      expect(params).toContainEqual({ appointmentId: 'appt-1' });
      expect(params).toContainEqual({ tenantId: TENANT });
      expect(params).toContainEqual({ active: PAYMENT_LINK_STATUS.ACTIVE });
    });

    it('is idempotent: running it again moves nothing', async () => {
      const { service, links } = build();
      const qb = createMockQueryBuilder();
      links.createQueryBuilder.mockReturnValue(qb);
      qb.execute.mockResolvedValue({ affected: 0 });
      expect(await service.markUsedForAppointment(TENANT, 'appt-1')).toBe(0);
    });

    it('treats a driver that reports no row count as zero', async () => {
      const { service, links } = build();
      const qb = createMockQueryBuilder();
      links.createQueryBuilder.mockReturnValue(qb);
      qb.execute.mockResolvedValue({ raw: [] });
      expect(await service.markUsedForAppointment(TENANT, 'appt-1')).toBe(0);
    });
  });

  describe('staff reads load the appointment id (so toView can tell a booking is attached)', () => {
    it('findOne / getByToken / list ask for the relation id only', async () => {
      const { service, links } = build();
      links.findOne.mockResolvedValue(row({ appointment: 'appt-1' }));
      await service.findOne(TENANT, 'l1');
      await service.getByToken(TENANT, TOKEN);
      links.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.list(TENANT, { page: 1, limit: 10 } as never);
      const asked = [
        ...links.findOne.mock.calls.map((c) => c[0]),
        ...links.findAndCount.mock.calls.map((c) => c[0]),
      ];
      for (const q of asked) {
        expect(q).toMatchObject({
          loadRelationIds: { relations: ['appointment'] },
        });
      }
    });

    it('disable flips the status with a column UPDATE, not a relation-cascading save', async () => {
      const { service, links } = build();
      links.findOne.mockResolvedValueOnce(row({ appointment: 'appt-1' }));
      const out = await service.disable(TENANT, 'l1');
      expect(out.status).toBe(PAYMENT_LINK_STATUS.DISABLED);
      expect(links.update).toHaveBeenCalledWith('l1', {
        status: PAYMENT_LINK_STATUS.DISABLED,
      });
      expect(links.save).not.toHaveBeenCalled();
    });
  });
});
