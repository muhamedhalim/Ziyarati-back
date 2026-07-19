import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Clinic-side merchant onboarding submission. The IBAN is accepted for
 * validation + masking only — it is NEVER stored in full (the bank-account
 * certificate goes through the verification-documents flow instead).
 */
export class SubmitMerchantAccountDto {
  @ApiPropertyOptional({ description: 'Bank name.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bankName?: string;

  @ApiPropertyOptional({ description: 'Account beneficiary (legal) name.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  beneficiaryName?: string;

  @ApiPropertyOptional({
    description: 'IBAN — stored masked (last 4 only), never in full.',
    example: 'SA0380000000608010167519',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}[0-9A-Za-z\s]{6,40}$/, { message: 'iban must be a valid IBAN' })
  iban?: string;
}
