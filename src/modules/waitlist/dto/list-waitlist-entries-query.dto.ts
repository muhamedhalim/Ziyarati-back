import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { PaginationQueryDto } from '../../crm/dto/pagination-query.dto';
import { WaitlistState } from '../../../entities/enums';

/** Spec 014 (Clinic Platform Completion) — T161 (US9, contracts F9 `GET /waitlist`). */
export class ListWaitlistEntriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WaitlistState })
  @IsOptional()
  @IsEnum(WaitlistState)
  state?: WaitlistState;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  serviceId?: string;
}
