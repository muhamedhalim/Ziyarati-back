/**
 * Real-PostgreSQL double-submit proof for FND-027 (Wave 1).
 *
 * TR-003a: concurrency cannot be certified from mocks. This suite boots the
 * real `AppModule` (via `createE2eApp`, the same bootstrap `webhooks.e2e-spec.ts`
 * and `refund-concurrency.e2e-spec.ts` use) against real Postgres.
 *
 * The bug (pre-fix): a manual ("New payment" — no `appointmentId`) creation
 * carries neither DB floor. The appointment-based partial unique index
 * (`uq_payments_appointment_pending`) doesn't apply (no appointment). The
 * `idempotency_key` unique index only engages when the CLIENT supplies a key
 * — the manual-payment UI never does. Two concurrent submits create two
 * separate Payment rows and, if a live gateway were configured, would charge
 * the card twice.
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-booking.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { In } from 'typeorm';

import { Payment } from '../src/entities/Payments/Payment';
import { Customer } from '../src/entities/CRM/Customer';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { MerchantAccount } from '../src/entities/Payments/MerchantAccount';
import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { TapSandbox } from './utils/tap-e2e';

const API = '/api/v1';

async function seedCustomer(e2e: E2eApp, tenantId: string, marker: string): Promise<Customer> {
  const customers = e2e.dataSource.getRepository(Customer);
  return customers.save(
    customers.create({
      tenant: { id: tenantId } as Tenant,
      phone: `+1555${marker.slice(-9)}`,
      email: `${marker}@example.test`,
      full_name: `E2E Customer ${marker}`,
    }),
  );
}

describe('Manual payment idempotency (FND-027, container-backed) — real Postgres', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;

  beforeAll(async () => {
    // PAY-009: a clinic charge needs an APPROVED Tap merchant (the payments gate added
    // after this suite was written); Tap itself is stubbed at the client boundary.
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(new TapSandbox().asClient()),
    );
    owner = await createOwnerFixture(e2e, 'payment-idem');
    const merchants = e2e.dataSource.getRepository(MerchantAccount);
    await merchants.save(
      merchants.create({
        tenant: { id: owner.tenantId } as Tenant,
        provider: 'tap',
        status: 'APPROVED',
        provider_recipient_id: `merchant_${randomUUID().slice(0, 10)}`,
        approved_at: new Date(),
      }),
    );
  }, 60_000);

  // NOTE: no per-tenant teardown here. `transactions` is append-only by DB
  // trigger (Principle XII, "an append-only, immutable financial history"),
  // and `payments`/`tenants` are FK-referenced by it with no cascade, so a
  // tenant that ever completes a charge can never be deleted again (real
  // production behavior, not a test artifact — see refund-concurrency.e2e-spec.ts
  // for the same discovery). Every test below uses a fresh customer under
  // this suite's own uniquely-suffixed tenant, so no cleanup is needed for
  // isolation.
  afterAll(async () => {
    await e2e.app.close();
  }, 30_000);

  it('two concurrent manual-payment submissions for the same customer+amount create exactly ONE payment', async () => {
    const marker = `pidem-${randomUUID().slice(0, 8)}`;
    const customer = await seedCustomer(e2e, owner.tenantId, marker);

    const [r1, r2] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/payments`)
        .set(...authHeader(owner.token))
        .send({ amount: 75, customerId: customer.id }),
      request(e2e.app.getHttpServer())
        .post(`${API}/payments`)
        .set(...authHeader(owner.token))
        .send({ amount: 75, customerId: customer.id }),
    ]);

    // Both callers get a clean 201 — the loser replays the winner's payment
    // rather than erroring (same contract as the existing client-supplied
    // idempotencyKey path — api-contracts.md §2.2: no shape change).
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const payments = e2e.dataSource.getRepository(Payment);
    const rows = await payments.find({
      where: { tenant: { id: owner.tenantId }, customer: { id: customer.id } },
    });
    expect(rows).toHaveLength(1); // FND-027: exactly one row — pre-fix this is 2

    expect(r1.body.payment.id).toBe(r2.body.payment.id); // both callers observe the SAME payment
  });

  it('two DIFFERENT customers submitting the same amount concurrently each get their OWN payment (no false-positive merge)', async () => {
    const marker = `pidem-${randomUUID().slice(0, 8)}`;
    const customerA = await seedCustomer(e2e, owner.tenantId, `${marker}-a`);
    const customerB = await seedCustomer(e2e, owner.tenantId, `${marker}-b`);

    const [rA, rB] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/payments`)
        .set(...authHeader(owner.token))
        .send({ amount: 75, customerId: customerA.id }),
      request(e2e.app.getHttpServer())
        .post(`${API}/payments`)
        .set(...authHeader(owner.token))
        .send({ amount: 75, customerId: customerB.id }),
    ]);

    expect(rA.status).toBe(201);
    expect(rB.status).toBe(201);
    expect(rA.body.payment.id).not.toBe(rB.body.payment.id); // distinct customers never merged

    const payments = e2e.dataSource.getRepository(Payment);
    const rows = await payments.find({
      where: { tenant: { id: owner.tenantId }, customer: { id: In([customerA.id, customerB.id]) } },
    });
    expect(rows).toHaveLength(2);
  });

  // AD-02 regression guard: a genuinely later, distinct manual payment for the
  // SAME customer+amount (not a double-click — a real second charge, e.g. a
  // follow-up visit) must still be possible. The client-supplied key remains
  // the reliable way to express that explicitly.
  it('a genuinely distinct second payment succeeds when the client supplies its own idempotency key', async () => {
    const marker = `pidem-${randomUUID().slice(0, 8)}`;
    const customer = await seedCustomer(e2e, owner.tenantId, marker);

    const first = await request(e2e.app.getHttpServer())
      .post(`${API}/payments`)
      .set(...authHeader(owner.token))
      .send({ amount: 75, customerId: customer.id, idempotencyKey: `${marker}-visit-1` });
    expect(first.status).toBe(201);

    const second = await request(e2e.app.getHttpServer())
      .post(`${API}/payments`)
      .set(...authHeader(owner.token))
      .send({ amount: 75, customerId: customer.id, idempotencyKey: `${marker}-visit-2` });
    expect(second.status).toBe(201);

    expect(first.body.payment.id).not.toBe(second.body.payment.id);

    const payments = e2e.dataSource.getRepository(Payment);
    const rows = await payments.find({
      where: { tenant: { id: owner.tenantId }, customer: { id: customer.id } },
    });
    expect(rows).toHaveLength(2);
  });
});
