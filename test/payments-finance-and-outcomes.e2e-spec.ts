/**
 * Tap migration, Phase 2 gate — finance classification + durable post-payment
 * effects (REL-005), against real Postgres (migrations-built `ziyarati_e2e`),
 * real Redis and real BullMQ. Only Tap's network is stubbed.
 *
 *  A. add-on and billing-upgrade payments over Tap are classified as PLATFORM
 *     revenue (purpose + settlement_mode), and the clinic payments list hides them;
 *  B. the settlement run claims ONLY the clinic's own, ZiyaraTech-held money;
 *  C. the outcome row is written in the SAME transaction as the payment state
 *     change — proven by making the outbox insert fail and watching the payment
 *     NOT become PAID (and become PAID on the retry);
 *  D. the durable chain: with the in-process fast path killed (a crash after the
 *     commit), the outbox row → real relay publish → real BullMQ worker running the
 *     real `PaymentsProcessor` → the entitlement is applied exactly once, and a
 *     replay changes nothing;
 *  E. the reconciliation sweep (which runs in the WORKER) recovers a lost webhook
 *     and the add-on is still granted.
 */
import './utils/tap-e2e-env.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  authHeader,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
  type SubscribedOwnerFixture,
} from './utils/subscription-e2e-fixtures';
import { TapSandbox, settle } from './utils/tap-e2e';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { PaymentReconciliationService } from '../src/modules/payments/payment-reconciliation.service';
import { ResourceEntitlementListener } from '../src/modules/resource-pricing/resource-entitlement.listener';
import { BillingUpgradeEntitlementListener } from '../src/modules/billing-upgrades/billing-upgrade-entitlement.listener';
import { AppointmentsService } from '../src/modules/appointment/appointment.service';
import { PaymentOutcomeService } from '../src/worker/payment-outcome.service';
import { PaymentsProcessor } from '../src/worker/processors/payments.processor';
import { OutboxRelayService } from '../src/worker/outbox-relay.service';
import { DistributedLockService } from '../src/queue/distributed-lock.service';
import { QueueService } from '../src/queue/queue.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { JOB, QUEUE, bullPrefix } from '../src/queue/queue.constants';
import { blockingConnectionOptions } from '../src/queue/redis.config';
import { FeatureKey } from '../src/modules/subscription-billing/feature-registry';

import { Payment } from '../src/entities/Payments/Payment';
import { Settlement } from '../src/entities/Payments/Settlement';
import { OutboxJob } from '../src/entities/Campaigns/OutboxJob';
import { ResourcePriceCatalog } from '../src/entities/ResourcePricing/ResourcePriceCatalog';
import { ResourcePurchase } from '../src/entities/ResourcePricing/ResourcePurchase';
import { BillingUpgradeRequest } from '../src/entities/BillingUpgrades/BillingUpgradeRequest';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../src/rbac/rbac.constants';
import {
  OutboxStatus,
  PaymentStatus,
  SettlementStatus,
} from '../src/entities/enums';

const API = '/api/v1';

describe('Payments — finance classification & durable outcomes (Tap Phase 2) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  let worker: Worker | undefined;
  const tap = new TapSandbox();

  const db = () => e2e.dataSource;
  const payments = () => db().getRepository(Payment);
  const purchases = () => db().getRepository(ResourcePurchase);
  const outbox = () => db().getRepository(OutboxJob);

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    const catalog = db().getRepository(ResourcePriceCatalog);
    const item = await catalog.findOneOrFail({
      where: { item_key: 'branches' },
    });
    item.unit_price_minor = '5000';
    item.is_active = true;
    await catalog.save(item);

    // A REAL BullMQ worker on the payments queue running the REAL processor, wired
    // with the same consumers the worker process wires. (The relay and the worker
    // process themselves are not started: the relay would claim every pending
    // outbox row of every other spec in this shared database.)
    const get = <T>(cls: new (...a: never[]) => T) =>
      e2e.moduleRef.get(cls, { strict: false });
    const outcome = new PaymentOutcomeService(
      db(),
      get(AppointmentsService),
      get(BillingUpgradeEntitlementListener),
      get(ResourceEntitlementListener),
    );
    const processor = new PaymentsProcessor(
      get(PaymentReconciliationService),
      outcome,
      get(DistributedLockService),
      get(MetricsService),
    );
    worker = new Worker(
      QUEUE.PAYMENTS,
      (job: Job) => processor.process(job as never),
      {
        connection: blockingConnectionOptions(e2e.config),
        prefix: bullPrefix(),
      },
    );
  }, 90_000);

  afterAll(async () => {
    await worker?.close();
    await settle();
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  // ── helpers ───────────────────────────────────────────────────────────────
  async function createPurchase(
    token: string,
    quantity = 1,
  ): Promise<ResourcePurchase> {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(token))
      .send({ itemKey: 'branches', quantity, idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    return purchases().findOneOrFail({
      where: { id: res.body.purchase.id },
      relations: { payment: true },
    });
  }
  const purchaseOf = (id: string) =>
    purchases().findOneOrFail({ where: { id } });
  const grants = (purchaseId: string) =>
    db().query(
      `SELECT id FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'grant'`,
      [purchaseId],
    );
  const outcomeRows = (paymentId: string) =>
    outbox()
      .createQueryBuilder('o')
      .where(
        `o.job_name = 'payments.outcome' AND o.payload->>'paymentId' = :paymentId`,
        {
          paymentId,
        },
      )
      .orderBy('o.created_at', 'ASC')
      .getMany();

  async function waitFor<T>(
    read: () => Promise<T>,
    done: (v: T) => boolean,
    what: string,
    timeoutMs = 15_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await read();
      if (done(v)) return v;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** The real relay's publish step, for ONE named row (not the whole table). */
  async function relayPublish(row: OutboxJob): Promise<void> {
    const relay = new OutboxRelayService(
      db(),
      e2e.moduleRef.get(QueueService, { strict: false }),
    );
    await (
      relay as unknown as { publishAndMark(r: OutboxJob): Promise<void> }
    ).publishAndMark(row);
  }

  // ═══ A. classification through the real flows ═══════════════════════════════
  describe('A. add-on and billing-upgrade payments are PLATFORM revenue', () => {
    it('an add-on payment is persisted ADDON / NONE, and the clinic payments list hides it unless asked', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-classify', {
        max_branches: 5,
      });
      const purchase = await createPurchase(owner.token);

      const row = await payments().findOneByOrFail({
        id: purchase.payment!.id,
      });
      expect(row).toMatchObject({
        gateway: 'tap',
        purpose: 'ADDON',
        settlement_mode: 'NONE',
        fees_reconciled_at: null,
      });

      const list = (qs = '') =>
        request(e2e.app.getHttpServer())
          .get(`${API}/payments${qs}`)
          .set(...authHeader(owner.token))
          .expect(200);

      const hidden = await list();
      expect(hidden.body.data.map((p: { id: string }) => p.id)).not.toContain(
        row.id,
      );

      const asked = await list('?purpose=ADDON');
      const found = asked.body.data.find(
        (p: { id: string }) => p.id === row.id,
      );
      expect(found).toMatchObject({
        purpose: 'ADDON',
        settlement_mode: 'NONE',
      });

      // the payment is still reachable by id (deep links keep working)
      await request(e2e.app.getHttpServer())
        .get(`${API}/payments/${row.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
    });

    it('rejects an unknown purpose filter', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-badfilter', {
        max_branches: 5,
      });
      await request(e2e.app.getHttpServer())
        .get(`${API}/payments?purpose=SUBSCRIPTION`)
        .set(...authHeader(owner.token))
        .expect(400);
    });

    /** A platform-scope user (tenantId NULL) holding the seeded global super_admin role. */
    async function createSuperAdmin(): Promise<string> {
      const role = await db()
        .getRepository(Role)
        .createQueryBuilder('r')
        .where('r.slug = :slug', { slug: ROLE.SUPER_ADMIN })
        .andWhere('r."tenantId" IS NULL')
        .getOneOrFail();
      const users = db().getRepository(User);
      const user = await users.save(
        users.create({
          tenant: undefined,
          email: `p2-sa-${randomUUID().slice(0, 8)}@example.test`,
          full_name: 'E2E Super Admin',
          is_active: true,
        }),
      );
      await db()
        .getRepository(UserRole)
        .save(
          db()
            .getRepository(UserRole)
            .create({
              user: { id: user.id } as User,
              role: { id: role.id } as Role,
            }),
        );
      return e2e.jwt.signAsync(
        { sub: user.id, tenantId: null, type: 'access' },
        {
          secret: e2e.config.get<string>(
            'JWT_ACCESS_SECRET',
            'dev-access-secret',
          ),
          expiresIn: '15m',
        },
      );
    }

    /** owner requests → super admin quotes → owner accepts: the REAL billing-upgrade flow. */
    async function requestQuoteAccept(
      owner: SubscribedOwnerFixture,
      superAdminToken: string,
      featureKey: string,
    ) {
      const server = e2e.app.getHttpServer();
      const created = await request(server)
        .post(`${API}/billing-upgrade-requests`)
        .set(...authHeader(owner.token))
        .send({ type: 'feature', featureKey })
        .expect(201);
      const id = created.body.id as string;

      await request(server)
        .post(`${API}/platform/billing-upgrade-requests/${id}/quote`)
        .set(...authHeader(superAdminToken))
        .send({
          finalPriceMinor: 15000,
          billingPeriod: 'one_time',
          quoteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(200);

      const accepted = await request(server)
        .post(`${API}/billing-upgrade-requests/${id}/accept`)
        .set(...authHeader(owner.token))
        .expect(200);
      return { id, accepted };
    }

    it('a billing upgrade over Tap (request → quote → accept → pay) is BILLING_UPGRADE / NONE and the paid webhook applies the grant', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-upgrade', {
        max_branches: 5,
      });
      const superAdmin = await createSuperAdmin();
      const requests = db().getRepository(BillingUpgradeRequest);

      const { id, accepted } = await requestQuoteAccept(
        owner,
        superAdmin,
        FeatureKey.AI_ASSISTANT,
      );
      expect(accepted.body.redirectUrl).toMatch(
        /^https:\/\/checkout\.tap\.test\//,
      );

      const reloaded = await requests.findOneOrFail({
        where: { id },
        relations: { payment: true },
      });
      expect(reloaded.status).toBe('payment_processing');
      expect(reloaded.payment).toMatchObject({
        gateway: 'tap',
        purpose: 'BILLING_UPGRADE',
        settlement_mode: 'NONE',
      });
      expect(Number(reloaded.payment!.amount)).toBe(150);

      const body = tap.chargeRequests[tap.chargeRequests.length - 1];
      expect(body).toMatchObject({
        source: { id: 'src_all' },
        merchant: { id: 'e2e-merchant' },
      });
      expect(body.platform).toBeUndefined();
      expect(String(body.redirect.url)).toMatch(
        /\/app\/billing\?checkout=return$/,
      );

      await tap
        .deliver(e2e.app, tap.capture(reloaded.payment!.gateway_payment_id!))
        .expect(200);
      await settle();

      expect((await requests.findOneOrFail({ where: { id } })).status).toBe(
        'completed',
      );
      const flags = await db().query(
        `SELECT is_enabled, source FROM feature_flags WHERE "tenantId" = $1 AND feature_key = $2`,
        [owner.tenantId, FeatureKey.AI_ASSISTANT],
      );
      expect(flags).toEqual([{ is_enabled: true, source: 'BILLING_UPGRADE' }]);
    });

    it('a DECLINED billing-upgrade payment moves the request to payment_failed (not stuck in payment_processing)', async () => {
      const owner = await createSubscribedOwnerFixture(
        e2e,
        'p2-upgrade-declined',
        { max_branches: 5 },
      );
      const superAdmin = await createSuperAdmin();
      const requests = db().getRepository(BillingUpgradeRequest);

      const { id } = await requestQuoteAccept(
        owner,
        superAdmin,
        FeatureKey.CAMPAIGNS,
      );
      const withPayment = await requests.findOneOrFail({
        where: { id },
        relations: { payment: true },
      });

      await tap
        .deliver(e2e.app, tap.decline(withPayment.payment!.gateway_payment_id!))
        .expect(200);
      await settle();

      expect((await requests.findOneOrFail({ where: { id } })).status).toBe(
        'payment_failed',
      );
      expect(
        await db().query(
          `SELECT 1 FROM feature_flags WHERE "tenantId" = $1 AND feature_key = $2 AND is_enabled`,
          [owner.tenantId, FeatureKey.CAMPAIGNS],
        ),
      ).toHaveLength(0);
    });
  });

  // ═══ B. settlement claim ═══════════════════════════════════════════════════
  describe("B. the settlement run claims only the clinic's own, ZiyaraTech-held money", () => {
    it('batches the INTERNAL clinic payment and leaves platform revenue, provider-settled and unclassified money alone', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-settle', {
        max_branches: 5,
      });
      const seed = (over: Partial<Payment>) =>
        payments().save(
          payments().create({
            tenant: { id: owner.tenantId } as Tenant,
            amount: 100,
            currency: 'SAR',
            status: PaymentStatus.PAID,
            paid_at: new Date(),
            gateway: 'tap',
            gateway_payment_id: `chg_${randomUUID()}`,
            ...over,
          }),
        );
      const clinic = await seed({
        purpose: 'BOOKING',
        settlement_mode: 'INTERNAL',
      });
      const manual = await seed({
        purpose: 'MANUAL',
        settlement_mode: 'INTERNAL',
        amount: 25,
      });
      const providerSettled = await seed({
        purpose: 'BOOKING',
        settlement_mode: 'PROVIDER',
      });
      const addon = await seed({ purpose: 'ADDON', settlement_mode: 'NONE' });
      const upgrade = await seed({
        purpose: 'BILLING_UPGRADE',
        settlement_mode: 'NONE',
      });
      const unknownPurpose = await seed({
        purpose: 'SUBSCRIPTION',
        settlement_mode: 'INTERNAL',
      });
      // even a mis-recorded mode on a platform purpose must not be claimable
      const platformButInternal = await seed({
        purpose: 'ADDON',
        settlement_mode: 'INTERNAL',
      });

      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/settlements/generate`)
        .set(...authHeader(owner.token))
        .send({})
        .expect(200);

      expect(Number(res.body.gross_amount)).toBe(125); // 100 + 25, nothing else
      const itemPaymentIds = res.body.items.map(
        (i: { payment?: { id: string }; paymentId?: string }) =>
          i.payment?.id ?? i.paymentId,
      );
      expect([...itemPaymentIds].sort()).toEqual([clinic.id, manual.id].sort());

      const status = async (p: Payment) =>
        (await payments().findOneByOrFail({ id: p.id })).settlement_status;
      expect(await status(clinic)).toBe(SettlementStatus.IN_BATCH);
      expect(await status(manual)).toBe(SettlementStatus.IN_BATCH);
      for (const untouched of [
        providerSettled,
        addon,
        upgrade,
        unknownPurpose,
        platformButInternal,
      ]) {
        expect(await status(untouched)).toBe(SettlementStatus.UNSETTLED);
      }

      // nothing claimable is left: a second run must refuse rather than batch platform revenue
      await request(e2e.app.getHttpServer())
        .post(`${API}/settlements/generate`)
        .set(...authHeader(owner.token))
        .send({})
        .expect(422);
      expect(
        await db()
          .getRepository(Settlement)
          .count({ where: { tenant: { id: owner.tenantId } } }),
      ).toBe(1);
    });
  });

  // ═══ C. atomicity ═════════════════════════════════════════════════════════
  describe('C. the outcome row commits WITH the payment state change', () => {
    afterEach(async () => {
      await db().query(`DROP TRIGGER IF EXISTS p2_fail_outcome ON outbox_jobs`);
      await db().query(`DROP FUNCTION IF EXISTS p2_fail_outcome_insert()`);
    });

    it('if the outbox insert fails the payment does NOT become PAID, and the retry books it', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-atomic', {
        max_branches: 5,
      });
      const purchase = await createPurchase(owner.token);
      const chargeId = purchase.payment!.gateway_payment_id!;
      const charge = tap.capture(chargeId);

      await db().query(`
        CREATE OR REPLACE FUNCTION p2_fail_outcome_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.job_name = 'payments.outcome' THEN
            RAISE EXCEPTION 'simulated outbox failure';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql`);
      await db().query(`
        CREATE TRIGGER p2_fail_outcome BEFORE INSERT ON outbox_jobs
        FOR EACH ROW EXECUTE FUNCTION p2_fail_outcome_insert()`);

      const failed = await tap.deliver(e2e.app, charge);
      await settle();

      // Tap would retry: a 5xx, and NOTHING half-applied.
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(
        (await payments().findOneByOrFail({ id: purchase.payment!.id })).status,
      ).toBe(PaymentStatus.PENDING);
      expect(
        await db().query(
          `SELECT 1 FROM transactions WHERE type = 'webhook' AND gateway_transaction_id = $1`,
          [`tap:${chargeId}:CAPTURED`],
        ),
      ).toHaveLength(0); // the dedupe row rolled back too, so the retry is not a "duplicate"
      expect(await outcomeRows(purchase.payment!.id)).toHaveLength(0);
      expect((await grants(purchase.id)).length).toBe(0);

      await db().query(`DROP TRIGGER p2_fail_outcome ON outbox_jobs`);
      const retried = await tap.deliver(e2e.app, charge).expect(200);
      await settle();

      expect(retried.body).toMatchObject({
        matched: true,
        status: 'PAID',
        deduplicated: false,
      });
      expect(
        (await payments().findOneByOrFail({ id: purchase.payment!.id })).status,
      ).toBe(PaymentStatus.PAID);
      const rows = await outcomeRows(purchase.payment!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        queue: 'payments',
        job_name: 'payments.outcome',
        dedupe_key: `payment-outcome-paid-${purchase.payment!.id}`,
        status: OutboxStatus.PENDING,
        payload: {
          tenantId: owner.tenantId,
          paymentId: purchase.payment!.id,
          outcome: 'paid',
        },
      });
    });

    it('a redelivered webhook writes no second row (ON CONFLICT DO NOTHING / dedupe)', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-once', {
        max_branches: 5,
      });
      const purchase = await createPurchase(owner.token);
      const charge = tap.capture(purchase.payment!.gateway_payment_id!);
      await tap.deliver(e2e.app, charge).expect(200);
      await tap.deliver(e2e.app, charge).expect(200);
      await tap.deliver(e2e.app, charge).expect(200);
      await settle();
      expect(await outcomeRows(purchase.payment!.id)).toHaveLength(1);
    });
  });

  // ═══ D. the durable chain ═════════════════════════════════════════════════
  describe('D. durable chain: outbox row → relay → BullMQ → PaymentsProcessor → consumer', () => {
    /** Pay a purchase with the in-process fast path KILLED, as if the process died after the commit. */
    async function payWithLostFastPath(
      owner: SubscribedOwnerFixture,
      quantity = 1,
    ) {
      const purchase = await createPurchase(owner.token, quantity);
      const spy = jest
        .spyOn(ResourceEntitlementListener.prototype, 'onPaymentSucceeded')
        .mockResolvedValue(undefined);
      try {
        await tap
          .deliver(e2e.app, tap.capture(purchase.payment!.gateway_payment_id!))
          .expect(200);
        await settle();
      } finally {
        spy.mockRestore();
      }
      return purchase;
    }

    it('applies the add-on exactly once after the fast path was lost, and a replay changes nothing', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-durable', {
        max_branches: 5,
      });
      const purchase = await payWithLostFastPath(owner);

      // State at the moment of the "crash": captured and recorded, consequences lost.
      expect(
        (await payments().findOneByOrFail({ id: purchase.payment!.id })).status,
      ).toBe(PaymentStatus.PAID);
      expect((await purchaseOf(purchase.id)).status).toBe('payment_processing');
      expect((await grants(purchase.id)).length).toBe(0);
      const [row] = await outcomeRows(purchase.payment!.id);
      expect(row.status).toBe(OutboxStatus.PENDING);

      // The real relay publishes it; the real worker consumes it.
      await relayPublish(row);
      expect((await outbox().findOneByOrFail({ id: row.id })).status).toBe(
        OutboxStatus.PUBLISHED,
      );

      await waitFor(
        () => purchaseOf(purchase.id),
        (p) => p.status === 'completed',
        'the durable consumer to complete the purchase',
      );
      expect((await grants(purchase.id)).length).toBe(1);

      // A duplicate job (a redelivery / a manual re-drive) is harmless.
      const queue = e2e.moduleRef.get(QueueService, { strict: false });
      const job = await queue.publish(
        QUEUE.PAYMENTS,
        JOB.PAYMENTS_OUTCOME,
        {
          tenantId: owner.tenantId,
          paymentId: purchase.payment!.id,
          outcome: 'paid',
        } as never,
        `replay-${randomUUID()}`,
      );
      await waitFor(
        async () => (await job.getState()) as string,
        (s) => s === 'completed',
        'the replayed job',
      );
      expect((await grants(purchase.id)).length).toBe(1); // still ONE
      expect((await purchaseOf(purchase.id)).status).toBe('completed');
    });

    it('a failed outcome job arriving after a late success does not regress the purchase', async () => {
      const owner = await createSubscribedOwnerFixture(
        e2e,
        'p2-nofailregress',
        { max_branches: 5 },
      );
      const purchase = await createPurchase(owner.token);
      await tap
        .deliver(e2e.app, tap.capture(purchase.payment!.gateway_payment_id!))
        .expect(200);
      await settle();
      expect((await purchaseOf(purchase.id)).status).toBe('completed');

      const queue = e2e.moduleRef.get(QueueService, { strict: false });
      const job = await queue.publish(
        QUEUE.PAYMENTS,
        JOB.PAYMENTS_OUTCOME,
        {
          tenantId: owner.tenantId,
          paymentId: purchase.payment!.id,
          outcome: 'failed',
        } as never,
        `failed-after-paid-${randomUUID()}`,
      );
      await waitFor(
        async () => (await job.getState()) as string,
        (s) => s === 'completed',
        'the failed job',
      );
      expect((await purchaseOf(purchase.id)).status).toBe('completed');
    });

    it('a job whose tenant does not own the payment is skipped, not applied', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-owner-a', {
        max_branches: 5,
      });
      const other = await createSubscribedOwnerFixture(e2e, 'p2-owner-b', {
        max_branches: 5,
      });
      const purchase = await payWithLostFastPath(owner);

      const queue = e2e.moduleRef.get(QueueService, { strict: false });
      const job = await queue.publish(
        QUEUE.PAYMENTS,
        JOB.PAYMENTS_OUTCOME,
        {
          tenantId: other.tenantId,
          paymentId: purchase.payment!.id,
          outcome: 'paid',
        } as never,
        `wrong-tenant-${randomUUID()}`,
      );
      await waitFor(
        async () => (await job.getState()) as string,
        (s) => s === 'completed',
        'the mismatched job',
      );

      expect((await grants(purchase.id)).length).toBe(0); // NOT applied on a foreign tenant's say-so
      expect((await purchaseOf(purchase.id)).status).toBe('payment_processing');
    });

    it('a real refund after the fast path was lost reverses the entitlement via the durable refund_recorded job', async () => {
      const owner = await createSubscribedOwnerFixture(
        e2e,
        'p2-durable-refund',
        { max_branches: 5 },
      );
      const purchase = await createPurchase(owner.token, 3);
      await tap
        .deliver(e2e.app, tap.capture(purchase.payment!.gateway_payment_id!))
        .expect(200);
      await settle();
      expect((await grants(purchase.id)).length).toBe(1);

      // Refund with the in-process revoke listener KILLED (crash after the commit).
      const spy = jest
        .spyOn(ResourceEntitlementListener.prototype, 'onRefundRecorded')
        .mockResolvedValue(undefined);
      try {
        await request(e2e.app.getHttpServer())
          .post(`${API}/refunds`)
          .set(...authHeader(owner.token))
          .send({ paymentId: purchase.payment!.id })
          .expect(201);
        await settle();
      } finally {
        spy.mockRestore();
      }
      expect((await purchaseOf(purchase.id)).status).toBe('completed'); // revoke was lost

      const rows = await outcomeRows(purchase.payment!.id);
      const refundRow = rows.find(
        (r) => (r.payload as { outcome: string }).outcome === 'refund_recorded',
      );
      expect(refundRow).toBeDefined();
      await relayPublish(refundRow!);

      await waitFor(
        () => purchaseOf(purchase.id),
        (p) => p.status === 'refunded',
        'the durable revoke',
      );
      const revokes = await db().query(
        `SELECT amount_units FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'revoke'`,
        [purchase.id],
      );
      expect(
        revokes.map((r: { amount_units: string }) => Number(r.amount_units)),
      ).toEqual([3]);
    });
  });

  // ═══ E. reconciliation recovers a lost webhook ════════════════════════════
  describe('E. the reconciliation sweep recovers a lost webhook and the add-on is still granted', () => {
    it('reconcile books PAID (writing the durable row) even when this process has no entitlement listener', async () => {
      const owner = await createSubscribedOwnerFixture(e2e, 'p2-recon', {
        max_branches: 5,
      });
      const purchase = await createPurchase(owner.token);
      const chargeId = purchase.payment!.gateway_payment_id!;
      tap.capture(chargeId); // Tap captured it; the webhook never arrived
      await db().query(
        `UPDATE payments SET created_at = now() - interval '3 hours' WHERE id = $1`,
        [purchase.payment!.id],
      );

      const recon = e2e.moduleRef.get(PaymentReconciliationService, {
        strict: false,
      });
      // Scope the sweep to THIS payment (the database is shared with every other spec),
      // but run the real reconcileOne / transaction / outbox code against it.
      const repo = (
        recon as unknown as {
          payments: { find: (o: unknown) => Promise<Payment[]> };
        }
      ).payments;
      const realFind = repo.find.bind(repo);
      const scope = jest
        .spyOn(repo, 'find')
        .mockImplementation(async (o) =>
          (await realFind(o)).filter((p) => p.id === purchase.payment!.id),
        );
      // The WORKER process does not load the entitlement listeners the API does.
      const noListener = jest
        .spyOn(ResourceEntitlementListener.prototype, 'onPaymentSucceeded')
        .mockResolvedValue(undefined);
      let summary;
      try {
        summary = await recon.reconcileStalePending();
        await settle();
      } finally {
        scope.mockRestore();
        noListener.mockRestore();
      }

      expect(summary).toMatchObject({
        scanned: 1,
        markedPaid: 1,
        mismatches: 0,
      });
      expect(
        (await payments().findOneByOrFail({ id: purchase.payment!.id })).status,
      ).toBe(PaymentStatus.PAID);
      expect((await purchaseOf(purchase.id)).status).toBe('payment_processing'); // the gap that existed

      const [row] = await outcomeRows(purchase.payment!.id);
      expect(row).toMatchObject({
        dedupe_key: `payment-outcome-paid-${purchase.payment!.id}`,
      });
      await relayPublish(row);

      await waitFor(
        () => purchaseOf(purchase.id),
        (p) => p.status === 'completed',
        'the durable consumer after reconciliation',
      );
      expect((await grants(purchase.id)).length).toBe(1);
    });
  });
});
