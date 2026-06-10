import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PaymentGateway } from '../../entities/Payments/PaymentGateway';
import { AppError, ErrorCode } from '../../common/errors';

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
 * Live gateway secrets (Moyasar keys) are NOT stored here — they live in env /
 * ConfigService and are read only by the gateway adapter. `config` holds
 * non-secret operational settings.
 */
@Injectable()
export class PaymentGatewayService {
  constructor(
    @InjectRepository(PaymentGateway)
    private readonly gateways: Repository<PaymentGateway>,
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

  create(dto: CreatePaymentGatewayDto): Promise<PaymentGateway> {
    return this.gateways.save(
      this.gateways.create({
        gateway_name: dto.gatewayName,
        is_active: dto.isActive ?? true,
        config: dto.config,
      }),
    );
  }

  async update(id: string, dto: UpdatePaymentGatewayDto): Promise<PaymentGateway> {
    const gateway = await this.get(id);
    if (dto.gatewayName !== undefined) gateway.gateway_name = dto.gatewayName;
    if (dto.isActive !== undefined) gateway.is_active = dto.isActive;
    if (dto.config !== undefined) gateway.config = dto.config;
    return this.gateways.save(gateway);
  }
}
