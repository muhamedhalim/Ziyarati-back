import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer } from '../../entities/CRM/Customer';
import { AppError, ErrorCode } from '../../common/errors';
import { ActivityAuditService } from '../activity-log/activity-audit.service';

export interface CustomerAiRepliesState {
  id: string;
  aiRepliesDisabled: boolean;
  aiRepliesDisabledAt: Date | null;
}

/** Audit action names. Allow-listed in `activity-allowlist.ts`. */
export const CUSTOMER_AI_AUDIT_ACTION = {
  DISABLED: 'customer.ai_replies_disabled',
  ENABLED: 'customer.ai_replies_enabled',
} as const;

/**
 * Excludes a patient from — or returns them to — the WhatsApp AI.
 *
 * The flag has its own service and route on purpose: it is not part of the
 * generic customer update, so a role that may edit a patient's contact details
 * (a doctor's `crm.customers.update_own`) cannot flip it, and an ordinary
 * customer payload can never carry it. The decision itself is taken by
 * `WhatsappAiPolicyService`; this only records the clinic's choice.
 *
 * Tenant-scoped on every read and write: another clinic's customer id is
 * indistinguishable from a missing one (404).
 */
@Injectable()
export class CustomerAiRepliesService {
  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly audit: ActivityAuditService,
  ) {}

  /** Idempotent: setting the state a patient already has changes and audits nothing. */
  async setDisabled(
    tenantId: string,
    actorUserId: string,
    customerId: string,
    disabled: boolean,
  ): Promise<CustomerAiRepliesState> {
    const current = await this.customers.findOne({
      where: { id: customerId, tenant: { id: tenantId } },
      select: {
        id: true,
        ai_replies_disabled: true,
        ai_replies_disabled_at: true,
      },
    });
    if (!current) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Customer not found',
      });
    }
    if (current.ai_replies_disabled === disabled) return this.view(current);

    const at = disabled ? new Date() : null;
    // A single tenant-scoped UPDATE: it cannot overwrite another column of the
    // customer row with a stale copy.
    await this.customers
      .createQueryBuilder()
      .update(Customer)
      .set({ ai_replies_disabled: disabled, ai_replies_disabled_at: at })
      .where('id = :id', { id: customerId })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .execute();

    await this.audit.record({
      tenantId,
      actorUserId,
      action: disabled
        ? CUSTOMER_AI_AUDIT_ACTION.DISABLED
        : CUSTOMER_AI_AUDIT_ACTION.ENABLED,
      entityType: 'customer',
      entityId: customerId,
      before: { ai_replies_disabled: current.ai_replies_disabled },
      after: { ai_replies_disabled: disabled },
    });

    return {
      id: customerId,
      aiRepliesDisabled: disabled,
      aiRepliesDisabledAt: at,
    };
  }

  private view(c: Customer): CustomerAiRepliesState {
    return {
      id: c.id,
      aiRepliesDisabled: c.ai_replies_disabled,
      aiRepliesDisabledAt: c.ai_replies_disabled_at ?? null,
    };
  }
}
