import { EntityManager, FindOptionsRelations, FindOptionsWhere } from 'typeorm';

import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';

/**
 * Row-lock a billing-upgrade request WITHOUT joining a nullable relation.
 *
 * Postgres refuses `SELECT … FOR UPDATE` when a locked table is on the nullable
 * side of an outer join ("FOR UPDATE cannot be applied to the nullable side of an
 * outer join"). TypeORM's `findOne({ relations, lock })` LEFT JOINs every relation
 * it loads, and `findOne({ where: { payment: { id } }, lock })` joins `payment`
 * (nullable) to evaluate the filter — so both fail on a real database. That made
 * the whole billing-upgrade flow (quote → accept → pay → apply) throw a 500 in
 * production, while the unit tests, which mock the repository, never noticed.
 *
 * So the lock is taken on the request row ALONE, and any relations the caller
 * needs are attached by a second, UNLOCKED read in the same transaction. That is
 * safe: the request row stays locked, so nothing else can change it between the
 * two reads, and the relations are only ever read here, never mutated.
 */
export async function lockRequest(
  manager: EntityManager,
  where: FindOptionsWhere<BillingUpgradeRequest>,
  relations?: FindOptionsRelations<BillingUpgradeRequest>,
): Promise<BillingUpgradeRequest | null> {
  const repo = manager.getRepository(BillingUpgradeRequest);
  const locked = await repo.findOne({
    where,
    // CR-47: callers filter on `tenant: { id }`, which joins `tenants`; `FOR UPDATE OF` keeps that row unlocked.
    lock: { mode: 'pessimistic_write', tables: ['billing_upgrade_requests'] },
  });
  if (!locked || !relations) return locked;
  return (
    (await repo.findOne({ where: { id: locked.id }, relations })) ?? locked
  );
}

/**
 * Same, looked up by the payment that settles it. Filters on the raw `"paymentId"`
 * FK column through the query builder, so `payments` is never joined at all
 * (see {@link lockRequest}) — the precedent `ResourceEntitlementListener` set.
 */
export async function lockRequestByPayment(
  manager: EntityManager,
  paymentId: string,
  relations?: FindOptionsRelations<BillingUpgradeRequest>,
): Promise<BillingUpgradeRequest | null> {
  const repo = manager.getRepository(BillingUpgradeRequest);
  const locked = await repo
    .createQueryBuilder('request')
    .where('request."paymentId" = :paymentId', { paymentId })
    .setLock('pessimistic_write')
    .getOne();
  if (!locked || !relations) return locked;
  return (
    (await repo.findOne({ where: { id: locked.id }, relations })) ?? locked
  );
}
