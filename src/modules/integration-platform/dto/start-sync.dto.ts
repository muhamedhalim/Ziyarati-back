import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

import {
  INTEGRATION_RESOURCES,
  SYNC_MODE,
  SYNC_DIRECTION,
} from '../integration-platform.constants';

/**
 * Start a synchronization run for one (connection, resource, direction). A
 * DB-level partial unique index rejects a second active run for the same tuple,
 * so duplicate active jobs cannot be created even under a race.
 */
export class StartSyncDto {
  @ApiProperty({ description: 'Connection to sync.', format: 'uuid' })
  @IsUUID('4')
  connectionId!: string;

  @ApiProperty({ description: 'Resource type to sync.', enum: INTEGRATION_RESOURCES })
  @IsString()
  @IsIn(INTEGRATION_RESOURCES)
  resourceType!: string;

  @ApiProperty({
    description: 'Direction. inbound = pull into platform; outbound = push to external.',
    enum: [SYNC_DIRECTION.INBOUND, SYNC_DIRECTION.OUTBOUND],
  })
  @IsString()
  @IsIn([SYNC_DIRECTION.INBOUND, SYNC_DIRECTION.OUTBOUND])
  direction!: string;

  @ApiPropertyOptional({
    description: 'full = ignore the cursor and re-scan (backfill); incremental (default) = resume from the last cursor.',
    enum: Object.values(SYNC_MODE),
    default: 'incremental',
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(SYNC_MODE))
  mode?: string;
}
