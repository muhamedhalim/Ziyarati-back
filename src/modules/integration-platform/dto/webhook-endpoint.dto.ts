import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  INBOUND_EVENTS,
  INBOUND_STATUS,
  WEBHOOK_MAX_TOLERANCE_SECONDS,
  WEBHOOK_SIGNATURE_SCHEMES,
} from '../integration-platform.constants';

/** Create the inbound webhook endpoint for a connection. */
export class CreateWebhookEndpointDto {
  @ApiProperty({ description: 'Connection this endpoint receives events for.', format: 'uuid' })
  @IsUUID('4')
  connectionId!: string;

  @ApiProperty({
    description: 'Event types to accept. Must be a subset of the supported list.',
    enum: INBOUND_EVENTS,
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INBOUND_EVENTS.length)
  @IsString({ each: true })
  @IsIn(INBOUND_EVENTS, { each: true })
  allowedEvents!: string[];

  @ApiPropertyOptional({
    description: 'Compiled signature scheme to verify with.',
    enum: WEBHOOK_SIGNATURE_SCHEMES,
    default: 'hmac_sha256_timestamped',
  })
  @IsOptional()
  @IsString()
  @IsIn(WEBHOOK_SIGNATURE_SCHEMES)
  signatureScheme?: string;

  @ApiPropertyOptional({
    description: 'Replay window in seconds.',
    minimum: 30,
    maximum: WEBHOOK_MAX_TOLERANCE_SECONDS,
    default: 300,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(WEBHOOK_MAX_TOLERANCE_SECONDS)
  toleranceSeconds?: number;
}

/** Partial update. The signing secret is rotated through its own endpoint. */
export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({ enum: INBOUND_EVENTS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INBOUND_EVENTS.length)
  @IsString({ each: true })
  @IsIn(INBOUND_EVENTS, { each: true })
  allowedEvents?: string[];

  @ApiPropertyOptional({ enum: WEBHOOK_SIGNATURE_SCHEMES })
  @IsOptional()
  @IsString()
  @IsIn(WEBHOOK_SIGNATURE_SCHEMES)
  signatureScheme?: string;

  @ApiPropertyOptional({ minimum: 30, maximum: WEBHOOK_MAX_TOLERANCE_SECONDS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(WEBHOOK_MAX_TOLERANCE_SECONDS)
  toleranceSeconds?: number;

  @ApiPropertyOptional({ description: 'Activate or deactivate the endpoint.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** Filter + pagination for inbound delivery history (never returns payloads). */
export class QueryInboundEventsDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  connectionId?: string;

  @ApiPropertyOptional({ enum: Object.values(INBOUND_STATUS) })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(INBOUND_STATUS))
  status?: string;

  @ApiPropertyOptional({ enum: INBOUND_EVENTS })
  @IsOptional()
  @IsString()
  @IsIn(INBOUND_EVENTS)
  eventType?: string;

  @ApiPropertyOptional({ description: 'Exact external record id.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
