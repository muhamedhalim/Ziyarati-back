import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Reason/note attached to approve / reject / suspend actions (audit trail). */
export class TenantApprovalActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
