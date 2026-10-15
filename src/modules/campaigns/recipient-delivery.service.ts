import { Injectable } from '@nestjs/common';
import { DataSource, In, Not } from 'typeorm';

import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { RecipientDelivery } from '../../entities/enums';

export interface DeliveryReceipt {
  /** Provider message id stored on the recipient at dispatch time. */
  providerRef: string;
  /** The delivery event reported by the provider/carrier. */
  event: RecipientDelivery;
  /**
   * The caller's tenant (FND-004) — from `TenantContextService` on the HTTP
   * path, or the webhook event's resolved `tenant.id` on the internal path.
   * Never client-supplied. Required (not optional) so no call site can
   * silently skip tenant scoping.
   */
  tenantId: string;
}

export type DeliveryResult =
  | { updated: true; delivery: RecipientDelivery }
  | { updated: false; reason: string };

/**
 * Ingests provider delivery callbacks and maintains the recipient `delivery`
 * axis + the run's `delivered`/`read` counters.
 *
 * This is the missing webhook seam: the worker owns `processing`, this service
 * owns `delivery`, so the two never clobber each other (a DELIVERED callback can
 * legitimately arrive before our own DISPATCHED commit).
 *
 * Correctness properties:
 *  - FORWARD-ONLY: NONE < ACCEPTED < DELIVERED < READ. An out-of-order or
 *    duplicate callback can never downgrade a recipient.
 *  - EXACTLY-ONCE counters: each run counter is incremented by a conditional
 *    UPDATE guarded on the prior delivery state, so concurrent/duplicate
 *    callbacks (webhooks are at-least-once) increment at most once.
 *  - Matched by `provider_ref` (UNIQUE) — the id the carrier echoes back.
 */
@Injectable()
export class RecipientDeliveryService {

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Phase 11 (US7, T136) — trusted-webhook variant for a platform-level
   * feedback endpoint with NO tenant principal to scope against (unlike the
   * HTTP delivery-status path, which always has one). Resolves the tenant
   * (and the recipient's own stored `email`, T130) FROM the recipient row
   * matched by `provider_ref` itself — never from the webhook payload's own
   * claimed fields — then delegates to {@link recordDelivery}'s existing,
   * already-tested transactional logic so the two paths can never disagree
   * on what a BOUNCED/DELIVERED/READ transition means.
   *
   * Callers MUST have already cryptographically verified the webhook before
   * calling this — there is no verification here.
   */
  async recordDeliveryTrusted(
    providerRef: string,
    event: RecipientDelivery,
  ): Promise<DeliveryResult & { tenantId?: string; email?: string }> {
    if (!providerRef) return { updated: false, reason: 'missing-provider-ref' };

    const rec = await this.dataSource.getRepository(CampaignRecipient).findOne({
      where: { provider_ref: providerRef },
      relations: { run: { tenant: true }, customer: true },
    });
    if (!rec?.run?.tenant)
      return { updated: false, reason: 'recipient-not-found' };

    const tenantId = rec.run.tenant.id;
    const email = rec.email ?? rec.customer?.email ?? undefined;
    const result = await this.recordDelivery({ providerRef, event, tenantId });
    return { ...result, tenantId, email };
  }

  async recordDelivery(receipt: DeliveryReceipt): Promise<DeliveryResult> {
    const { providerRef, event, tenantId } = receipt;
    if (!providerRef) return { updated: false, reason: 'missing-provider-ref' };

    return this.dataSource.transaction(async (mgr) => {
      // FND-004 — tenant-scoped in the SAME query, not a post-hoc check: a
      // foreign-tenant provider_ref simply doesn't match, exactly like every
      // other tenant-isolated lookup in this codebase (cross-tenant = "not
      // found", never a distinguishable 403). CampaignRecipient carries no
      // tenant column of its own — scoped via its run's tenant instead (the
      // same relation `relations: { run: true }` already loads).
      const rec = await mgr.findOne(CampaignRecipient, {
        where: { provider_ref: providerRef, run: { tenant: { id: tenantId } } },
        relations: { run: true },
      });
      if (!rec?.run) return { updated: false, reason: 'recipient-not-found' };
      const runId = rec.run.id;

      // Hard delivery failure — terminal, no counter (the send itself succeeded).
      if (event === RecipientDelivery.BOUNCED) {
        const res = await mgr.update(
          CampaignRecipient,
          { id: rec.id, delivery: Not(RecipientDelivery.BOUNCED) },
          { delivery: RecipientDelivery.BOUNCED },
        );
        return (res.affected ?? 0) > 0
          ? { updated: true, delivery: RecipientDelivery.BOUNCED }
          : { updated: false, reason: 'already-bounced' };
      }

      const target = this.rank(event);
      if (target < 0) return { updated: false, reason: 'unknown-event' };

      let updated = false;

      // Advance to ACCEPTED.
      if (target >= 1) {
        const r = await mgr.update(
          CampaignRecipient,
          { id: rec.id, delivery: RecipientDelivery.NONE },
          { delivery: RecipientDelivery.ACCEPTED },
        );
        updated ||= (r.affected ?? 0) > 0;
      }
      // Advance to DELIVERED (+count once).
      if (target >= 2) {
        const r = await mgr.update(
          CampaignRecipient,
          {
            id: rec.id,
            delivery: In([RecipientDelivery.NONE, RecipientDelivery.ACCEPTED]),
          },
          { delivery: RecipientDelivery.DELIVERED, delivered_at: new Date() },
        );
        if ((r.affected ?? 0) > 0) {
          await this.incrRun(mgr, runId, 'delivered');
          updated = true;
        }
      }
      // Advance to READ (+count once).
      if (target >= 3) {
        const r = await mgr.update(
          CampaignRecipient,
          {
            id: rec.id,
            delivery: In([
              RecipientDelivery.NONE,
              RecipientDelivery.ACCEPTED,
              RecipientDelivery.DELIVERED,
            ]),
          },
          { delivery: RecipientDelivery.READ },
        );
        if ((r.affected ?? 0) > 0) {
          await this.incrRun(mgr, runId, 'read');
          updated = true;
        }
      }

      return updated
        ? { updated: true, delivery: event }
        : { updated: false, reason: 'no-forward-transition' };
    });
  }

  /** NONE < ACCEPTED < DELIVERED < READ. (-1 = not a forward-progress event.) */
  private rank(d: RecipientDelivery): number {
    switch (d) {
      case RecipientDelivery.NONE:
        return 0;
      case RecipientDelivery.ACCEPTED:
        return 1;
      case RecipientDelivery.DELIVERED:
        return 2;
      case RecipientDelivery.READ:
        return 3;
      default:
        return -1;
    }
  }

  private incrRun(
    mgr: DataSource['manager'],
    runId: string,
    field: 'delivered' | 'read',
  ) {
    return mgr
      .createQueryBuilder()
      .update(CampaignRun)
      .set({ [field]: () => `${field} + 1` })
      .where('id = :runId', { runId })
      .execute();
  }
}
