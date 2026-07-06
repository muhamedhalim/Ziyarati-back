import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Transfers an active handover to another staff user (creates a new request). */
export class TransferHandoverDto {
  @ApiProperty({ description: 'Staff user to transfer to (tenant-scoped).', format: 'uuid' })
  @IsUUID()
  toUserId!: string;

  @ApiPropertyOptional({ description: 'Reason for the transfer.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
