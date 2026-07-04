import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/** Convert a guest conversation into a patient conversation (Feature 1). */
export class ConvertGuestDto {
  @ApiProperty({ format: 'uuid', description: 'The guest AI conversation to convert.' })
  @IsUUID()
  guestConversationId!: string;

  @ApiProperty({ format: 'uuid', description: 'The clinic (tenant) the visitor booked with.' })
  @IsUUID()
  tenantId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The created patient/customer id.' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
