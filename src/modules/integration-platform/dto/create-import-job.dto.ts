import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import { ImportRecordDto } from './batch-import.dto';
import { IMPORT_MODE, MAX_ASYNC_IMPORT_BATCH } from '../integration-platform.constants';

/**
 * Create an ASYNC import job. The request validates, persists a job row, enqueues
 * processing, and returns the tenant-facing job id immediately. Bounded at
 * MAX_ASYNC_IMPORT_BATCH so a single job can never balloon the jobs table.
 */
export class CreateImportJobDto {
  @ApiProperty({ description: 'Connection this import belongs to.', format: 'uuid' })
  @IsUUID('4')
  connectionId!: string;

  @ApiPropertyOptional({ description: 'Validate + report counts without writing (preview).', default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: 'partial (default) or atomic. Atomic is rejected unless transactional support exists.',
    enum: Object.values(IMPORT_MODE),
    default: 'partial',
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(IMPORT_MODE))
  mode?: string;

  @ApiProperty({ description: 'Records to import.', type: [ImportRecordDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ASYNC_IMPORT_BATCH)
  @ValidateNested({ each: true })
  @Type(() => ImportRecordDto)
  records!: ImportRecordDto[];
}
