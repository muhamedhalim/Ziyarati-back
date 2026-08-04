/**
 * Real-PostgreSQL concurrency proof for FND-026 (Wave 1).
 *
 * TR-003a: concurrency cannot be certified from mocks. This suite boots the
 * real `AppModule` (via `createE2eApp`, the same bootstrap `webhooks.e2e-spec.ts`
 * and `dlq-replay-idempotency.e2e-spec.ts` use) against real Postgres
 * (`ziyaratech-postgres`), so `RefundService.create`'s `pessimistic_write` lock
 * performs an actual row lock under a genuine race — not a scripted mock.
 *
 * The bug (pre-fix): `sumSucceededCents` (the admission check inside the
 * locked `persistIntent` phase) counts only `SUCCEEDED` refunds, never
 * `PENDING` ones. The lock correctly serializes two concurrent refund
 * requests against the same payment, but each one — reading a fresh view
 * AFTER the other's PENDING row already committed — still sees the
 * cumulative SUCCEEDED total as zero, so both are admitted. Two partial
 * refunds of 60 against a 100 payment both succeed: 120 admitted against a
 * 100 balance.
 */
import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Payment } from '../src/entities/Payments/Payment';
import { Refund } from '../src/entities/Payments/Refund';
import { PaymentStatus } from '../src/entities/enums';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';

const API = '/api/v1';
const toCents = (v: number | string): number => Math.round(Number(v) * 100);

async function seedPaidPayment(e2e: E2eApp, tenantId: string, amount: number): Promise<Payment> {
  const payments = e2e.dataSource.getRepository(Payment);
  return payments.save(
    payments.create({
      tenant: { id: tenantId } as Tenant,
      amount,
      currency: 'SAR',
      status: PaymentStatus.PAID,
      gateway: 'noop',
      paid_at: new Date(),
    }),
  );
}

describe('Refund concurrency (FND-026, container-backed) — real Postgres', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'refund-race');
  }, 60_000);

  // NOTE: no per-tenant teardown here. `transactions` is append-only by DB
  // trigger (`transactions_no_mutate` — Principle XII, "an append-only,
  // immutable financial history"), and `payments`/`tenants` are FK-referenced
  // by it with no cascade, so a tenant that ever completes a refund can never
  // be deleted again (by design — this is real production behavior, not a
  // test artifact). `cleanupTenant` is therefore skipped: every test below
  // uses a FRESH payment (a fresh UUID) under this suite's own uniquely-
  // suffixed tenant, so no cleanup is needed for isolation. The tenant row is
  // intentionally left behind, exactly as a real tenant with refund history
  // would be.
  afterAll(async () => {
    await e2e.app.close();
  }, 30_000);

  it('two concurrent partial refunds on one payment never admit more than the payment amount', async () => {
    const payment = await seedPaidPayment(e2e, owner.tenantId, 100);

    const [r1, r2] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/refunds`)
        .set(...authHeader(owner.token))
        .send({ paymentId: payment.id, amount: 60 }),
      request(e2e.app.getHttpServer())
        .post(`${API}/refunds`)
        .set(...authHeader(owner.token))
        .send({ paymentId: payment.id, amount: 60 }),
    ]);

    // The DIRECT proof of FND-026: sum every non-FAILED refund against this
    // payment and assert it never exceeds the payment amount. Pre-fix this
    // is 120 > 100 (both 201s). Post-fix exactly one is admitted.
    const refunds = e2e.dataSource.getRepository(Refund);
    const rows = await refunds.find({ where: { payment: { id: payment.id } } });
    const admittedC = rows
      .filter((r) => r.status !== 'FAILED')
      .reduce((sum, r) => sum + toCents(r.amount), 0);

    expect(admittedC).toBeLessThanOrEqual(toCents(payment.amount));

    // Also assert the HTTP-visible symptom: exactly one caller is admitted,
    // the other is refused with the existing UNPROCESSABLE_ENTITY contract
    // (api-contracts.md §2.3 — no new error code).
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 422]);
  });

  it('three concurrent refunds at 40 each against a 100 payment admit at most two', async () => {
    const payment = await seedPaidPayment(e2e, owner.tenantId, 100);

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        request(e2e.app.getHttpServer())
          .post(`${API}/refunds`)
          .set(...authHeader(owner.token))
          .send({ paymentId: payment.id, amount: 40 }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded.length).toBeLessThanOrEqual(2); // 3×40=120 > 100; at most 2×40=80 fits

    const refunds = e2e.dataSource.getRepository(Refund);
    const rows = await refunds.find({ where: { payment: { id: payment.id } } });
    const admittedC = rows
      .filter((r) => r.status !== 'FAILED')
      .reduce((sum, r) => sum + toCents(r.amount), 0);
    expect(admittedC).toBeLessThanOrEqual(toCents(payment.amount));
  });

  // AD-01 regression guard: the fix must not reject the ordinary, single,
  // non-concurrent refund path it's meant to leave untouched.
  it('a single legitimate full refund still succeeds', async () => {
    const payment = await seedPaidPayment(e2e, owner.tenantId, 50);

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/refunds`)
      .set(...authHeader(owner.token))
      .send({ paymentId: payment.id });

    expect(res.status).toBe(201);
    expect(Number(res.body.amount)).toBe(50);
    expect(res.body.status).toBe('SUCCEEDED');
  });

  it('a single legitimate partial refund followed by a second within the remaining balance both succeed', async () => {
    const payment = await seedPaidPayment(e2e, owner.tenantId, 100);

    const first = await request(e2e.app.getHttpServer())
      .post(`${API}/refunds`)
      .set(...authHeader(owner.token))
      .send({ paymentId: payment.id, amount: 30 });
    expect(first.status).toBe(201);

    const second = await request(e2e.app.getHttpServer())
      .post(`${API}/refunds`)
      .set(...authHeader(owner.token))
      .send({ paymentId: payment.id, amount: 30 });
    expect(second.status).toBe(201);

    const refunds = e2e.dataSource.getRepository(Refund);
    const rows = await refunds.find({ where: { payment: { id: payment.id } } });
    const admittedC = rows
      .filter((r) => r.status !== 'FAILED')
      .reduce((sum, r) => sum + toCents(r.amount), 0);
    expect(admittedC).toBe(6000); // 30 + 30, in cents — exactly, not clamped short
  });
});
