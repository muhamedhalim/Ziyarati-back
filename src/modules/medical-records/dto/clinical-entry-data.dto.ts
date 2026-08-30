import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Spec 014 (Clinic Platform Completion) — T103/T107 (US6, data-model.md
 * §1.3, FR-H002, FR-H013).
 *
 * Per-`ClinicalEntryKind` shape for `ClinicalEntry.data`. Validated
 * explicitly by `ClinicalRecordService` (not a controller `ValidationPipe`
 * — `kind` selects which of these 5 shapes applies, a discriminated choice
 * a single route-level DTO can't express). Ranges are REJECTION bounds, not
 * clinical advice: they exclude impossible input, nothing more.
 */
export class ClinicalNoteDataDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text!: string;
}

export class ClinicalDiagnosisDataDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsIn(['ACTIVE', 'RESOLVED'])
  status!: 'ACTIVE' | 'RESOLVED';
}

export class ClinicalMedicationDataDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  dose?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frequency?: string;

  @IsOptional()
  @IsDateString()
  startedOn?: string;

  @IsOptional()
  @IsDateString()
  endedOn?: string;

  @IsBoolean()
  active!: boolean;
}

export class ClinicalAllergyDataDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  substance!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reaction?: string;

  @IsIn(['MILD', 'MODERATE', 'SEVERE'])
  severity!: 'MILD' | 'MODERATE' | 'SEVERE';
}

export class ClinicalVitalsDataDto {
  @IsOptional()
  @IsNumber()
  @Min(40)
  @Max(300)
  systolic?: number;

  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(200)
  diastolic?: number;

  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(300)
  heartRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(25)
  @Max(45)
  temperatureC?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.2)
  @Max(500)
  weightKg?: number;

  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(260)
  heightCm?: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(100)
  spo2?: number;
}
