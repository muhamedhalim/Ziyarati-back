import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { StaffCommission, CommissionType } from '../../entities/Staff/StaffCommission';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Service } from '../../entities/Services/Service';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppointmentStatus } from '../../entities/enums';

import { AppError, ErrorCode } from '../../common/errors';
import { CreateCommissionDto } from './dto/create-commission.dto';
import { CommissionSummaryQueryDto } from './dto/commission-summary.query.dto';

/**
 * Staff commission RULES + computed earnings report.
 *
 * The `staff_commissions` table stores rules (per staff, optionally per
 * service). There is no per-appointment commission ledger, so earned
 * commission is COMPUTED on demand by walking completed appointments and
 * applying the matching rule — a pure calculation hook, no schema change.
 *
 * Tenant isolation: every query is scoped by `tenant: { id }`.
 */
@Injectable()
export class StaffCommissionService {
  constructor(
    @InjectRepository(StaffCommission)
    private readonly commissions: Repository<StaffCommission>,
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
  ) {}

  async create(
    tenantId: string,
    staffId: string,
    dto: CreateCommissionDto,
  ): Promise<StaffCommission> {
    await this.assertStaff(tenantId, staffId);

    const row = this.commissions.create({
      staff: { id: staffId } as StaffProfile,
      tenant: { id: tenantId } as Tenant,
      service: dto.serviceId ? ({ id: dto.serviceId } as Service) : undefined,
      commission_type: dto.commissionType,
      commission_value: dto.commissionValue,
    });
    return this.commissions.save(row);
  }

  async list(tenantId: string, staffId: string): Promise<StaffCommission[]> {
    await this.assertStaff(tenantId, staffId);
    return this.commissions.find({
      where: { staff: { id: staffId }, tenant: { id: tenantId } },
      relations: { service: true },
      order: { created_at: 'DESC' },
    });
  }

  /** Pure calculation hook — apply a rule to a base amount. */
  computeCommission(rule: StaffCommission, baseAmount: number): number {
    const value = Number(rule.commission_value);
    return rule.commission_type === CommissionType.PERCENT
      ? +(baseAmount * (value / 100)).toFixed(2)
      : +value.toFixed(2);
  }

  /**
   * Aggregated commission report for a staff member over a date range. Walks
   * the staff's COMPLETED appointments, applies the service-specific rule
   * (falling back to the staff default rule with no service), and sums it.
   */
  async summary(
    tenantId: string,
    staffId: string,
    query: CommissionSummaryQueryDto,
  ) {
    await this.assertStaff(tenantId, staffId);

    const now = new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.to ? new Date(query.to) : now;

    const rules = await this.commissions.find({
      where: { staff: { id: staffId }, tenant: { id: tenantId } },
      relations: { service: true },
    });
    const ruleByService = new Map<string, StaffCommission>();
    let defaultRule: StaffCommission | undefined;
    for (const r of rules) {
      if (r.service) ruleByService.set(r.service.id, r);
      else defaultRule = r;
    }

    const appts = await this.appointments.find({
      where: {
        staff: { id: staffId },
        tenant: { id: tenantId },
        status: AppointmentStatus.COMPLETED,
        start_at: Between(from, to),
      },
      relations: { services: { service: true } },
    });

    const breakdown = new Map<
      string,
      { serviceId: string; serviceName?: string; count: number; base: number; commission: number }
    >();
    let totalCommission = 0;
    let totalBase = 0;

    for (const appt of appts) {
      for (const line of appt.services ?? []) {
        const serviceId = line.service?.id ?? 'unknown';
        const price = Number(line.price ?? 0);
        const rule = (line.service && ruleByService.get(line.service.id)) || defaultRule;
        if (!rule) continue;

        const commission = this.computeCommission(rule, price);
        totalCommission += commission;
        totalBase += price;

        const entry =
          breakdown.get(serviceId) ?? {
            serviceId,
            serviceName: line.service?.name,
            count: 0,
            base: 0,
            commission: 0,
          };
        entry.count += 1;
        entry.base = +(entry.base + price).toFixed(2);
        entry.commission = +(entry.commission + commission).toFixed(2);
        breakdown.set(serviceId, entry);
      }
    }

    return {
      staffId,
      from: from.toISOString(),
      to: to.toISOString(),
      appointmentsCount: appts.length,
      totalBaseAmount: +totalBase.toFixed(2),
      totalCommission: +totalCommission.toFixed(2),
      breakdown: [...breakdown.values()],
      rulesApplied: rules.length,
    };
  }

  private async assertStaff(tenantId: string, staffId: string): Promise<void> {
    const ok = await this.staff.exists({
      where: { id: staffId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
  }
}
