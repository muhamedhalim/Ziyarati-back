import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { MAX_SYNC_IMPORT_BATCH } from '../integration-platform.constants';

/** One record within a batch import. */
export class ImportRecordDto {
  @ApiProperty({ description: "The external system's own id for this record.", example: 'PMS-10432' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalId!: string;

  @ApiProperty({ description: 'Resource fields (domain field names). Protected fields are rejected.', type: Object })
  @IsObject()
  data!: Record<string, unknown>;
}

/**
 * Synchronous, BOUNDED batch import of one resource type for one connection.
 * Capped at MAX_SYNC_IMPORT_BATCH — larger jobs belong on the async import
 * queue (deferred) so an HTTP request is never held open for a large import.
 *
 * `dryRun` validates + reports counts without writing. `atomic` rolls the whole
 * batch back on any per-record failure; the default is partial success.
 */
export class BatchImportDto {
  @ApiProperty({ description: 'Connection this import belongs to.', format: 'uuid' })
  @IsUUID('4')
  connectionId!: string;

  @ApiPropertyOptional({ description: 'Validate and report counts without writing.', default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ description: 'Roll the whole batch back on any failure.', default: false })
  @IsOptional()
  @IsBoolean()
  atomic?: boolean;

  @ApiProperty({ description: 'Records to import.', type: [ImportRecordDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SYNC_IMPORT_BATCH)
  @ValidateNested({ each: true })
  @Type(() => ImportRecordDto)
  records!: ImportRecordDto[];
}
