import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Reason/note attached to approve / reject / suspend actions (audit trail). */
export class TenantApprovalActionDto {
  @ApiPropertyOptional({
    description:
      'Optional reason or note for this action. Recorded in the approval event log and may be surfaced to the clinic owner via notification.',
    example: 'All required documents verified and approved.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
