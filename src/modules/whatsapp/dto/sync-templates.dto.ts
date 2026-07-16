import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Selects which connected account's WABA to sync templates from. */
export class SyncTemplatesDto {
  @ApiPropertyOptional({
    description:
      'WhatsApp account whose WABA to sync. Omit to use the clinic\'s default account. Must belong to the caller\'s tenant.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}
