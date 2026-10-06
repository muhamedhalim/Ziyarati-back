import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  DSR_STATUSES,
  DSR_TYPES,
} from '../../../entities/Governance/DataSubjectRequest';

export const DSR_CHANNELS = [
  'in_person',
  'phone',
  'email',
  'portal',
  'other',
] as const;

export class CreateDataSubjectRequestDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The patient (customer) the request is from.',
  })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ enum: DSR_TYPES })
  @IsIn(DSR_TYPES as unknown as string[])
  type!: (typeof DSR_TYPES)[number];

  @ApiProperty({
    enum: DSR_CHANNELS,
    description: 'How the request reached the clinic.',
  })
  @IsIn(DSR_CHANNELS as unknown as string[])
  channel!: (typeof DSR_CHANNELS)[number];

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Procedural remark only. Refused if it contains an identifier, email or phone number.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class QueryDataSubjectRequestsDto {
  @ApiPropertyOptional({ enum: DSR_STATUSES })
  @IsOptional()
  @IsIn(DSR_STATUSES as unknown as string[])
  status?: (typeof DSR_STATUSES)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class EraseSubjectDto {
  @ApiProperty({
    enum: ['retain', 'erase'],
    description:
      'REQUIRED, no default. Whether health / clinical content (profile, notes, documents, clinical entries, ' +
      'appointment notes, chat transcripts) is kept or erased. Retention of clinical records is a legal ' +
      'decision for the clinic; the choice is written to the deletion evidence.',
  })
  @IsIn(['retain', 'erase'])
  clinical!: 'retain' | 'erase';

  @ApiPropertyOptional({
    description:
      'Run every step and report exact counts, then roll back. Nothing is changed.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class CloseDataSubjectRequestDto {
  @ApiProperty({ enum: ['COMPLETED', 'REJECTED'] })
  @IsIn(['COMPLETED', 'REJECTED'])
  status!: 'COMPLETED' | 'REJECTED';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
