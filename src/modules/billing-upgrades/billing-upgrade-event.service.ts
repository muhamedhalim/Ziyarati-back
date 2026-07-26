import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { BillingUpgradeRequestEvent } from '../../entities/BillingUpgrades/BillingUpgradeRequestEvent';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { User } from '../../entities/Auth&RBAC/User';
import { BillingUpgradeEventType } from './billing-upgrade.constants';

export interface RecordBillingUpgradeEventInput {
  requestId: string;
  type: BillingUpgradeEventType;
  fromValue?: string;
  toValue?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  internalOnly?: boolean;
  actorId?: string;
  actorName?: string;
}

/**
 * Writes to `billing_upgrade_request_events` — the append-only status-history
 * / audit trail for a request (mirrors SupportTicketEvent). Shared by both the
 * owner-side and platform-side services so every transition is logged the
 * same way. Accepts an optional transaction `manager` so a history row can
 * commit atomically with the state change it describes.
 */
@Injectable()
export class BillingUpgradeEventService {
  constructor(
    @InjectRepository(BillingUpgradeRequestEvent)
    private readonly events: Repository<BillingUpgradeRequestEvent>,
  ) {}

  async record(input: RecordBillingUpgradeEventInput, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(BillingUpgradeRequestEvent) : this.events;
    await repo.save(
      repo.create({
        request: { id: input.requestId } as BillingUpgradeRequest,
        type: input.type,
        from_value: input.fromValue,
        to_value: input.toValue,
        note: input.note,
        metadata: input.metadata,
        internal_only: input.internalOnly ?? false,
        actor: input.actorId ? ({ id: input.actorId } as User) : undefined,
        actor_name: input.actorName,
      }),
    );
  }

  /** Owner-visible history — excludes internal-only super-admin notes. */
  listVisible(requestId: string): Promise<BillingUpgradeRequestEvent[]> {
    return this.events.find({
      where: { request: { id: requestId }, internal_only: false },
      order: { created_at: 'ASC' },
    });
  }

  /** Full history, including internal-only notes — platform view only. */
  listAll(requestId: string): Promise<BillingUpgradeRequestEvent[]> {
    return this.events.find({
      where: { request: { id: requestId } },
      order: { created_at: 'ASC' },
    });
  }
}
