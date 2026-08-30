import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  Min,
} from 'class-validator';

import { ClinicalEntryKind } from '../../../entities/enums';

/** `POST /clinical/patients/:customerId/entries` and `.../encounters/:id/entries`. */
export class CreateClinicalEntryDto {
  @ApiProperty({ enum: ClinicalEntryKind })
  @IsEnum(ClinicalEntryKind)
  kind!: ClinicalEntryKind;

  @ApiProperty({
    description: 'Kind-specific payload — see the per-kind DTOs.',
  })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiProperty({ required: false, description: 'Defaults to now if omitted.' })
  @IsOptional()
  @IsDateString()
  recordedAt?: string;
}

/** `PATCH /clinical/entries/:id` — a stale `version` is rejected with 409 (FR-H009). */
export class CorrectClinicalEntryDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({ description: 'Full replacement payload for the entry kind.' })
  @IsObject()
  data!: Record<string, unknown>;
}

/** `POST /clinical/patients/:customerId/encounters`. */
export class CreateClinicalEncounterDto {
  @ApiProperty({ required: false })
  @IsOptional()
  appointmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  branchId?: string;

  @ApiProperty({ required: false, description: 'Defaults to now if omitted.' })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  summary?: string;
}
