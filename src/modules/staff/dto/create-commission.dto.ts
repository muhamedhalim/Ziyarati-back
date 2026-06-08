import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommissionType } from '../../../entities/Staff/StaffCommission';

/**
 * Defines a commission RULE for a staff member. If `serviceId` is supplied the
 * rule is service-specific; otherwise it is the staff member's default rule.
 * Earned commission is computed from these rules over completed appointments
 * (see the commission summary endpoint) — no per-appointment ledger is stored.
 */
export class CreateCommissionDto {
  @ApiProperty({
    description: 'How the commission is expressed: `PERCENT` (of the service price) or `FIXED` (absolute amount).',
    enum: CommissionType,
    example: CommissionType.PERCENT,
  })
  @IsEnum(CommissionType)
  commissionType!: CommissionType;

  @ApiProperty({
    description:
      'The commission value. For `PERCENT` this is a percentage (e.g. 15 = 15%); for `FIXED` it is an absolute amount.',
    example: 15,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  commissionValue!: number;

  @ApiPropertyOptional({
    description: 'Optional service this rule applies to. Omit for the staff member\'s default rule across all services.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000040',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;
}
