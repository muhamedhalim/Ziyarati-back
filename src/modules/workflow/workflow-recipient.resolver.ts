import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { WORKFLOW_RECIPIENT_TYPE } from './workflow.constants';

export interface ResolvedWorkflowContact {
  phone?: string;
  email?: string;
}

/** Values for the `{{customerName}}` / `{{clinicName}}` message placeholders. */
export interface WorkflowPlaceholderValues {
  /** The patient's FIRST name only (never the full legal name). */
  customerName?: string;
  clinicName?: string;
}

/**
 * Turns a workflow action's `recipientType` (CUSTOMER | STAFF) + the run's
 * context into an actual phone/email — the one thing this codebase had no
 * shared helper for (CUSTOMER resolution was duplicated inline in
 * `NotificationDispatchService`/`WhatsappExecutionService`; STAFF had no
 * resolution path at all). Tenant-scoped on every lookup.
 */
@Injectable()
export class WorkflowRecipientResolver {
  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(StaffProfile)
    private readonly staffProfiles: Repository<StaffProfile>,
  ) {}

  async resolve(
    tenantId: string,
    recipientType: string,
    context: Record<string, unknown>,
  ): Promise<ResolvedWorkflowContact | null> {
    if (recipientType === WORKFLOW_RECIPIENT_TYPE.CUSTOMER) {
      const customerId = this.str(context.customerId);
      if (!customerId) return null;
      const customer = await this.customers.findOne({
        where: { id: customerId, tenant: { id: tenantId } },
      });
      if (!customer) return null;
      return { phone: customer.phone, email: customer.email ?? undefined };
    }

    if (recipientType === WORKFLOW_RECIPIENT_TYPE.STAFF) {
      const staffId = this.str(context.staffId);
      if (!staffId) return null;
      const staff = await this.staffProfiles.findOne({
        where: { id: staffId, tenant: { id: tenantId } },
        relations: { user: true },
      });
      if (!staff?.user) return null;
      return {
        phone: staff.user.phone ?? undefined,
        email: staff.user.email ?? undefined,
      };
    }

    return null;
  }

  /**
   * Resolves the message placeholders for one run: the patient named by
   * `context.customerId` and the clinic itself. Tenant-scoped on both lookups;
   * a missing value is simply absent (the caller decides the fallback). Only
   * called when a message actually contains a placeholder, so every existing
   * workflow — whose text has none — pays nothing for it.
   *
   * The clinic is read through the customers repository's own entity manager
   * so this resolver keeps its two-argument constructor (it is constructed
   * positionally by the tenant-isolation integration spec).
   */
  async placeholderValues(
    tenantId: string,
    context: Record<string, unknown>,
  ): Promise<WorkflowPlaceholderValues> {
    const customerId = this.str(context.customerId);
    const [customer, tenant] = await Promise.all([
      customerId
        ? this.customers.findOne({
            where: { id: customerId, tenant: { id: tenantId } },
            select: { id: true, full_name: true },
          })
        : Promise.resolve(null),
      this.customers.manager.findOne(Tenant, {
        where: { id: tenantId },
        select: { id: true, name: true },
      }),
    ]);
    const firstName = customer?.full_name?.trim().split(/\s+/)[0];
    return {
      customerName: firstName || undefined,
      clinicName: tenant?.name?.trim() || undefined,
    };
  }

  /**
   * Picks one real, already-existing customer + staff member for this
   * tenant, for the manual "Test Run" endpoint's context — so a dry run
   * exercises real recipient resolution without the caller ever supplying an
   * id themselves (per FR: "use existing, authorized data within the
   * current tenant"). Either/both may be absent for a brand-new tenant with
   * no customers/staff yet; callers must handle that.
   */
  async pickSampleContext(
    tenantId: string,
  ): Promise<{ customerId?: string; staffId?: string }> {
    const [customer, staff] = await Promise.all([
      this.customers.findOne({
        where: { tenant: { id: tenantId } },
        order: { created_at: 'DESC' },
      }),
      this.staffProfiles.findOne({
        where: { tenant: { id: tenantId } },
        order: { created_at: 'ASC' },
      }),
    ]);
    return { customerId: customer?.id, staffId: staff?.id };
  }

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v : undefined;
  }
}
