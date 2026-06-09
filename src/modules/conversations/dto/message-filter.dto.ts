import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MESSAGE_TYPES, SENDER_TYPE } from '../conversation.constants';

/** Filter + pagination for messages within a conversation (tenant-scoped). */
export class MessageFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by sender type.',
    enum: [SENDER_TYPE.CUSTOMER, SENDER_TYPE.AGENT, SENDER_TYPE.BOT, SENDER_TYPE.SYSTEM],
    example: SENDER_TYPE.AGENT,
  })
  @IsOptional()
  @IsIn([SENDER_TYPE.CUSTOMER, SENDER_TYPE.AGENT, SENDER_TYPE.BOT, SENDER_TYPE.SYSTEM])
  senderType?: string;

  @ApiPropertyOptional({ description: 'Filter by message type.', enum: MESSAGE_TYPES })
  @IsOptional()
  @IsIn(MESSAGE_TYPES)
  messageType?: string;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on `created_at`. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on `created_at`. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 200.', example: 50, minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
