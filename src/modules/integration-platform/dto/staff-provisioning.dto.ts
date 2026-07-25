import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { STAFF_PROVISIONING_STATUS } from '../integration-platform.constants';

/** Filter + pagination for the staff provisioning review queue. */
export class QueryStaffProvisioningDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  connectionId?: string;

  @ApiPropertyOptional({
    description: '`open` (default) = pending + ambiguous.',
    enum: [...Object.values(STAFF_PROVISIONING_STATUS), 'open'],
    default: 'open',
  })
  @IsOptional()
  @IsString()
  @IsIn([...Object.values(STAFF_PROVISIONING_STATUS), 'open'])
  status?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/**
 * Approve a request and provision the account. The ROLE is required and chosen
 * by the approving admin — it is never taken from the external system, and it is
 * validated against the tenant's assignable-role catalogue (which refuses
 * owner/super-admin and other non-staff roles).
 */
export class ApproveStaffProvisioningDto {
  @ApiProperty({ description: 'Role slug to grant. Validated against the assignable-role policy.' })
  @IsString()
  @MaxLength(60)
  roleSlug!: string;

  @ApiPropertyOptional({ description: 'Override the proposed login email.' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'Override the proposed full name.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @ApiPropertyOptional({ description: 'Branches to assign.', format: 'uuid', isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  branchIds?: string[];

  @ApiPropertyOptional({ description: 'Primary branch (must be one of branchIds).', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  primaryBranchId?: string;
}

/** Resolve a request by linking it to an EXISTING staff member (no new account). */
export class LinkStaffProvisioningDto {
  @ApiProperty({ description: 'Existing staff profile to map this external record to.', format: 'uuid' })
  @IsUUID('4')
  staffId!: string;
}

/** Decline a request. No account is created and no mapping is made. */
export class RejectStaffProvisioningDto {
  @ApiPropertyOptional({ description: 'Safe, short note for the audit trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
