import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Re-activate an unlinked mapping, optionally retargeting it. */
export class RelinkMappingDto {
  @ApiPropertyOptional({
    description:
      'Internal record to point the mapping at. Omit to re-activate the original pairing. Retargeting keeps the previous pairing as an unlinked historical row.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  internalResourceId?: string;
}

/** Reconnect a disconnected connection, optionally carrying its mappings over. */
export class ReconnectConnectionDto {
  @ApiPropertyOptional({
    description:
      'Replacement connection to carry this connection\'s active mappings over to. Omit to reactivate this connection in place (its own mappings are already attached).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  replacementConnectionId?: string;
}
