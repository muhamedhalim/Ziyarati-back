import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Track a raw analytics event for the caller's tenant. Tenant is NEVER taken
 * from input. `branchId`, when given, is validated to belong to the tenant.
 */
export class TrackEventDto {
  @ApiProperty({ description: 'Event type / name.', example: 'appointment.created' })
  @IsString()
  @MaxLength(100)
  event_type!: string;

  @ApiPropertyOptional({ description: 'Related entity type.', example: 'appointment' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity_type?: string;

  @ApiPropertyOptional({ description: 'Related entity id.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  entity_id?: string;

  @ApiPropertyOptional({ description: 'Branch the event belongs to.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Arbitrary event payload.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
