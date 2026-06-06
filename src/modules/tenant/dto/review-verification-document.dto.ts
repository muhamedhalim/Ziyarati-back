import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { VerificationDocStatus } from '../../../entities/enums';

/** Super-admin decision on a submitted verification document. */
export class ReviewVerificationDocumentDto {
  @IsIn([VerificationDocStatus.APPROVED, VerificationDocStatus.REJECTED])
  status!: VerificationDocStatus.APPROVED | VerificationDocStatus.REJECTED;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNote?: string;
}
