/**
 * Payment audit Phase 4 (PAY audit §17) — cross-tenant isolation of every financial
 * object reachable by id, against real Postgres + Redis (Tap stubbed at the client).
 *
 * Clinic B's owner holds every permission on THEIR tenant, so a refusal here can only
 * come from tenant scoping, not from missing rights. For each of clinic A's payment,
 * refund, payment link, settlement and transaction ids the answer must be 404 (never
 * 200, never a 403 that confirms the id exists) and nothing may change: no Tap call,
 * no refund row, the payment still PAID, the link still active.
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-booking.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createE2eApp, authHeader, type E2eApp } from './utils/whatsapp-e2e-app';
import { TapSandbox, settle } from './utils/tap-e2e';
import { TapBookingFixtures, type Clinic } from './utils/tap-booking-fixtures';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { Refund } from '../src/entities/Payments/Refund';
import { Settlement } from '../src/entities/Payments/Settlement';
import { PaymentLink } from '../src/entities/Payments/PaymentLink';
import { Transaction } from '../src/entities/Payments/Transaction';
import { PaymentStatus } from '../src/entities/enums';

const API = '/api/v1';
const SUITE = `iso-${randomUUID().slice(0, 8)}`;

describe('Financial objects are tenant-isolated (audit Phase 4) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();
  let fx: TapBookingFixtures;
  let a: Clinic;
  let b: Clinic;
  let paymentId: string;
  let refundId: string;
  let linkId: string;
  let linkToken: string;
  let settlementId: string;
  let transactionId: string;

  const db = () => e2e.dataSource;
  const http = () => request(e2e.app.getHttpServer());
  const asB = (method: 'get' | 'post', path: string) =>
    http()[method](`${API}${path}`).set(...authHeader(b.owner.token));

  beforeAll(async () => {
    e2e = await createE2eApp((x) => x.overrideProvider(TapApiClient).useValue(tap.asClient()));
    fx = new TapBookingFixtures(e2e, tap, SUITE);
    a = await fx.makeClinic('isoa');
    b = await fx.makeClinic('isob');
    await fx.approve(a);
    await fx.approve(b);

    const { payment } = await fx.paidBooking(a, (p) => http().post(`${API}${p}`));
    paymentId = payment.id;
    const refundRes = await http()
      .post(`${API}/refunds`)
      .set(...authHeader(a.owner.token))
      .send({ paymentId, amount: 10 })
      .expect(201);
    refundId = refundRes.body.id;

    const withLink = await fx.bookWithLink(a);
    linkToken = withLink.token;
    linkId = (
      await db().getRepository(PaymentLink).findOneOrFail({ where: { link_token: linkToken } })
    ).id;

    const settlements = db().getRepository(Settlement);
    const settlement = (await settlements.save(
      settlements.create({ tenant: { id: a.tenantId } } as never),
    )) as unknown as Settlement;
    settlementId = settlement.id;

    const tx = await db()
      .getRepository(Transaction)
      .findOneOrFail({ where: { payment: { id: paymentId } } });
    transactionId = tx.id;
  }, 180_000);

  afterAll(async () => {
    await settle();
    await e2e.app.close();
  }, 30_000);

  it('sanity: clinic A can read its own objects', async () => {
    const own = (path: string) => http().get(`${API}${path}`).set(...authHeader(a.owner.token));
    await own(`/payments/${paymentId}`).expect(200);
    await own(`/refunds/${refundId}`).expect(200);
    await own(`/payment-links/${linkId}`).expect(200);
    await own(`/settlements/${settlementId}`).expect(200);
    await own(`/transactions/${transactionId}`).expect(200);
  });

  it.each([
    ['payment', () => `/payments/${paymentId}`],
    ['payment status', () => `/payments/${paymentId}/status`],
    ['refund', () => `/refunds/${refundId}`],
    ['payment link by id', () => `/payment-links/${linkId}`],
    ['payment link by token', () => `/payment-links/token/${linkToken}`],
    ['settlement', () => `/settlements/${settlementId}`],
    ['transaction', () => `/transactions/${transactionId}`],
  ])("clinic B cannot read clinic A's %s by id (404)", async (_n, path) => {
    await asB('get', path()).expect(404);
  });

  it("clinic B's lists never contain clinic A's rows", async () => {
    const ids = async (path: string) =>
      ((await asB('get', path).expect(200)).body.data ?? []).map((r: { id: string }) => r.id);
    expect(await ids('/payments')).not.toContain(paymentId);
    expect(await ids('/refunds')).not.toContain(refundId);
    expect(await ids('/payment-links')).not.toContain(linkId);
    expect(await ids('/settlements')).not.toContain(settlementId);
    expect(await ids('/transactions')).not.toContain(transactionId);
  });

  it("clinic B cannot refund, confirm or disable clinic A's money — and nothing moves", async () => {
    const refundsBefore = await db().getRepository(Refund).count();
    const tapRefundsBefore = tap.refundRequests.length;

    await asB('post', '/refunds').send({ paymentId, amount: 5, idempotencyKey: randomUUID() }).expect(404);
    await asB('post', `/payments/${paymentId}/confirm`).send({}).expect(404);
    await asB('post', `/payment-links/${linkId}/disable`).send({}).expect(404);

    expect(tap.refundRequests).toHaveLength(tapRefundsBefore);
    expect(await db().getRepository(Refund).count()).toBe(refundsBefore);
    const payment = await fx.paymentRow(paymentId);
    expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    const link = await db().getRepository(PaymentLink).findOneOrFail({ where: { id: linkId } });
    expect(link.status).toBe('ACTIVE');
  });

  it('a tenantId smuggled in the body does not redirect a refund to another tenant', async () => {
    const before = await db().getRepository(Refund).count();
    const res = await asB('post', '/refunds').send({
      paymentId,
      amount: 5,
      tenantId: a.tenantId,
      idempotencyKey: randomUUID(),
    });
    expect([400, 404]).toContain(res.status);
    expect(await db().getRepository(Refund).count()).toBe(before);
  });

  it('unauthenticated callers are refused on every financial route (401)', async () => {
    for (const path of [
      `/payments/${paymentId}`,
      `/refunds/${refundId}`,
      `/payment-links/${linkId}`,
      `/settlements/${settlementId}`,
      `/transactions/${transactionId}`,
    ]) {
      await http().get(`${API}${path}`).expect(401);
    }
    await http().post(`${API}/refunds`).send({ paymentId, amount: 1 }).expect(401);
  });
});
