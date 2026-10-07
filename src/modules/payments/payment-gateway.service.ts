import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PaymentGateway } from '../../entities/Payments/PaymentGateway';
import { AppError, ErrorCode } from '../../common/errors';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';

import {
  CreatePaymentGatewayDto,
  UpdatePaymentGatewayDto,
} from './dto/upsert-payment-gateway.dto';

/**
 * PLATFORM-ONLY gateway configuration (`payment_gateways`).
 *
 * CRITICAL: payment infrastructure is owned by the PLATFORM, not by tenants.
 * These records are platform-level (created with no tenant) and the controller
 * restricts access to super admins. There is deliberately NO tenant scoping
 * here — tenants only ever CONSUME payment services, never configure them.
 *
 * Live gateway secrets (Tap keys) are NOT stored here — they live in env /
 * ConfigService and are read only by the gateway adapter. `config` holds
 * non-secret operational settings.
 */
@Injectable()
export class PaymentGatewayService {
  constructor(
    @InjectRepository(PaymentGateway)
    private readonly gateways: Repository<PaymentGateway>,
    private readonly audit: PlatformAdminAuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  list(): Promise<PaymentGateway[]> {
    return this.gateways.find({ order: { created_at: 'DESC' } });
  }

  async get(id: string): Promise<PaymentGateway> {
    const gateway = await this.gateways.findOne({ where: { id } });
    if (!gateway) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment gateway not found' });
    }
    return gateway;
  }

  async create(dto: CreatePaymentGatewayDto): Promise<PaymentGateway> {
    const result = await this.gateways.save(
      this.gateways.create({
        gateway_name: dto.gatewayName,
        is_active: dto.isActive ?? true,
        config: dto.config,
      }),
    );
    // FND-015: audits identity/activation state only — `config` is excluded
    // from the audit payload even though it's documented as non-secret, so an
    // operator mistake (pasting a live key into the "operational" field) can
    // never leak into the audit trail.
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.GATEWAY_CREATE,
      userId: this.actorId(),
      entityType: 'payment_gateway',
      entityId: result.id,
      before: null,
      after: { gatewayName: result.gateway_name, isActive: result.is_active, hasConfig: !!result.config },
    });
    return result;
  }

  async update(id: string, dto: UpdatePaymentGatewayDto): Promise<PaymentGateway> {
    const gateway = await this.get(id);
    const before = { gatewayName: gateway.gateway_name, isActive: gateway.is_active, hasConfig: !!gateway.config };
    if (dto.gatewayName !== undefined) gateway.gateway_name = dto.gatewayName;
    if (dto.isActive !== undefined) gateway.is_active = dto.isActive;
    if (dto.config !== undefined) gateway.config = dto.config;
    const result = await this.gateways.save(gateway);
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.GATEWAY_UPDATE,
      userId: this.actorId(),
      entityType: 'payment_gateway',
      entityId: result.id,
      before,
      after: { gatewayName: result.gateway_name, isActive: result.is_active, hasConfig: !!result.config },
    });
    return result;
  }

  private actorId(): string | undefined {
    return this.tenantContext.getUser()?.id;
  }
}
