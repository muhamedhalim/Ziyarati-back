import { Type } from 'class-transformer';
import {
  IsInt,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const MEMORY_TYPES = ['preference', 'summary', 'booking', 'faq', 'doctor', 'language', 'note'] as const;

export class RememberDto {
  @ApiProperty({ enum: MEMORY_TYPES, description: 'Memory kind.' })
  @IsIn(MEMORY_TYPES as unknown as string[]) type!: string;

  @ApiProperty({ description: 'The fact to remember.', minLength: 2, maxLength: 4000 })
  @IsString() @MinLength(2) @MaxLength(4000) content!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, default: 1, description: 'Importance (ranking + retention).' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) importance?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Patient linkage.' })
  @IsOptional() @IsUUID() customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() aiConversationId?: string;

  @ApiPropertyOptional({ description: 'ISO expiry — memory is purged/ignored after this.' })
  @IsOptional() @IsString() expiresAt?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class RecallDto {
  @ApiProperty({ description: 'Query to semantically recall relevant memories.', minLength: 2, maxLength: 2000 })
  @IsString() @MinLength(2) @MaxLength(2000) query!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Scope to a patient (shared/tenant memories still match).' })
  @IsOptional() @IsUUID() customerId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 5 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
}

export class MemoryFilterDto {
  @ApiPropertyOptional({ enum: MEMORY_TYPES })
  @IsOptional() @IsIn(MEMORY_TYPES as unknown as string[]) type?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() customerId?: string;

  @ApiPropertyOptional({ description: 'Search memory content.' })
  @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Exclude expired memories.' })
  @IsOptional() @IsIn(['true', 'false']) activeOnly?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}
