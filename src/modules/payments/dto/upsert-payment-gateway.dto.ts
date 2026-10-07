import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * PLATFORM-ONLY. Register a payment gateway configuration (super admin).
 *
 * NEVER put live secrets (e.g. a gateway secret key) here — those live in env /
 * ConfigService and are consumed only by the gateway adapter. `config` is for
 * non-secret, operational settings (labels, mode flags, public ids).
 */
export class CreatePaymentGatewayDto {
  @ApiProperty({ description: 'Gateway identifier.', example: 'tap' })
  @IsString()
  @MaxLength(100)
  gatewayName!: string;

  @ApiPropertyOptional({ description: 'Whether the gateway is active.', example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Non-secret operational config (labels, mode, public ids).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;
}

/** PLATFORM-ONLY. Update a payment gateway configuration (super admin). */
export class UpdatePaymentGatewayDto {
  @ApiPropertyOptional({ description: 'Gateway identifier.', example: 'tap' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  gatewayName?: string;

  @ApiPropertyOptional({ description: 'Whether the gateway is active.', example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Non-secret operational config.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;
}
