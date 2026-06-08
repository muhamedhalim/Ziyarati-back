import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationDocStatus } from '../../../entities/enums';

/** Super-admin decision on a submitted verification document. */
export class ReviewVerificationDocumentDto {
  @ApiProperty({
    description:
      'Review decision. `approved` — document is valid and accepted. `rejected` — document is invalid; include a `reviewNote` explaining what is wrong.',
    enum: [VerificationDocStatus.APPROVED, VerificationDocStatus.REJECTED],
    example: VerificationDocStatus.APPROVED,
  })
  @IsIn([VerificationDocStatus.APPROVED, VerificationDocStatus.REJECTED])
  status!: VerificationDocStatus.APPROVED | VerificationDocStatus.REJECTED;

  @ApiPropertyOptional({
    description:
      'Reviewer\'s note for the clinic owner. **Required when rejecting** — explain clearly what is wrong and what the owner should submit instead.',
    example: 'Document is blurry — please re-upload a high-quality scan of the original certificate.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNote?: string;
}
