import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { QueryMyTicketsDto } from './query-my-tickets.dto';

/** Platform (super-admin) ticket list — everything `QueryMyTicketsDto` has, plus a tenant filter. */
export class QuerySupportTicketsDto extends QueryMyTicketsDto {
  @ApiPropertyOptional({ description: 'Filter to a single tenant.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;
}
