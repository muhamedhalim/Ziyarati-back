import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Assigns a handover request to a staff user (status → ASSIGNED). */
export class AssignHandoverDto {
  @ApiProperty({ description: 'Staff user to assign (tenant-scoped).', format: 'uuid' })
  @IsUUID()
  assignedToUserId!: string;
}
