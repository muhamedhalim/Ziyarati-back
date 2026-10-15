import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { DELIVERY_STATUS, DeliveryStatus } from './notification.constants';

export type DeliveryEvent = DeliveryStatus;

export type DeliveryResultOut =
  | { updated: true; delivery: DeliveryStatus }
  | { updated: false; reason: string };

/**
 * Applies provider delivery callbacks to the recipient's `delivery_status` axis.
 *
 * Matched by the UNIQUE `provider_ref` (so it is inherently tenant-correct — the
 * row carries its own tenant). FORWARD-ONLY (NONE < ACCEPTED < DELIVERED < READ)
 * via conditional UPDATEs, so out-of-order / duplicate / at-least-once webhooks
 * can never downgrade state or double-apply. The worker owns `status`; this owns
 * `delivery_status` — they never write the same column.
 */
@Injectable()
export class NotificationDeliveryService {

  constructor(
    @InjectRepository(ScheduledNotification)
    private readonly scheduled: Repository<ScheduledNotification>,
  ) {}

  async recordDelivery(providerRef: string, event: DeliveryEvent): Promise<DeliveryResultOut> {
    if (!providerRef) return { updated: false, reason: 'missing-provider-ref' };

    if (event === DELIVERY_STATUS.FAILED) {
      const res = await this.scheduled.update(
        { provider_ref: providerRef, delivery_status: Not(DELIVERY_STATUS.FAILED) },
        { delivery_status: DELIVERY_STATUS.FAILED },
      );
      return (res.affected ?? 0) > 0
        ? { updated: true, delivery: DELIVERY_STATUS.FAILED }
        : { updated: false, reason: 'not-found-or-already-failed' };
    }

    const target = this.rank(event);
    if (target < 0) return { updated: false, reason: 'unknown-event' };

    let updated = false;
    if (target >= 1) {
      const r = await this.scheduled.update(
        { provider_ref: providerRef, delivery_status: DELIVERY_STATUS.NONE },
        { delivery_status: DELIVERY_STATUS.ACCEPTED },
      );
      updated ||= (r.affected ?? 0) > 0;
    }
    if (target >= 2) {
      const r = await this.scheduled.update(
        { provider_ref: providerRef, delivery_status: In([DELIVERY_STATUS.NONE, DELIVERY_STATUS.ACCEPTED]) },
        { delivery_status: DELIVERY_STATUS.DELIVERED, delivered_at: new Date() },
      );
      updated ||= (r.affected ?? 0) > 0;
    }
    if (target >= 3) {
      const r = await this.scheduled.update(
        {
          provider_ref: providerRef,
          delivery_status: In([DELIVERY_STATUS.NONE, DELIVERY_STATUS.ACCEPTED, DELIVERY_STATUS.DELIVERED]),
        },
        { delivery_status: DELIVERY_STATUS.READ },
      );
      updated ||= (r.affected ?? 0) > 0;
    }

    if (!updated) {
      // Either no such provider_ref, or already at/ahead of this state.
      const exists = await this.scheduled.exists({ where: { provider_ref: providerRef } });
      return { updated: false, reason: exists ? 'no-forward-transition' : 'recipient-not-found' };
    }
    return { updated: true, delivery: event };
  }

  private rank(d: DeliveryStatus): number {
    switch (d) {
      case DELIVERY_STATUS.NONE:
        return 0;
      case DELIVERY_STATUS.ACCEPTED:
        return 1;
      case DELIVERY_STATUS.DELIVERED:
        return 2;
      case DELIVERY_STATUS.READ:
        return 3;
      default:
        return -1;
    }
  }
}
