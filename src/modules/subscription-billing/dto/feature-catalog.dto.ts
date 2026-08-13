import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const KEY_PATTERN = /^[a-z0-9._-]+$/;

/** Metered usage metrics a feature can be capped by (limit read from the plan). */
export const FEATURE_USAGE_METRICS = [
  'AI_TOKENS',
  'WHATSAPP_MESSAGES',
  'APPOINTMENTS',
  'CAMPAIGNS',
] as const;

/** Create or update a feature catalog definition (super-admin). */
export class UpsertFeatureDefinitionDto {
  @ApiProperty({ example: 'ai.assistant', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  @Matches(KEY_PATTERN, {
    message: 'featureKey must be lowercase alphanumeric with . _ -',
  })
  featureKey!: string;

  @ApiProperty({ example: 'AI Assistant', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'AI-powered chat + booking assistant.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'AI', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({
    description: 'Effective value for tenants without an override.',
  })
  @IsOptional()
  @IsBoolean()
  defaultEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Whether the feature is shown in management.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    enum: ['public', 'internal'],
    description: 'Tenant-visible or platform-only.',
  })
  @IsOptional()
  @IsIn(['public', 'internal'])
  visibility?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isBeta?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDeprecated?: boolean;

  @ApiPropertyOptional({
    enum: FEATURE_USAGE_METRICS,
    description:
      'Metered quota this feature is capped by (limit read from the plan).',
  })
  @IsOptional()
  @IsIn(FEATURE_USAGE_METRICS as unknown as string[])
  usageMetric?: string;
}

/** Set the plans a feature is available on (empty = all plans). */
export class SetFeaturePlansDto {
  @ApiProperty({
    type: [String],
    description: 'Subscription plan ids (from the Subscription Module).',
  })
  @IsArray()
  @IsUUID(undefined, { each: true })
  planIds!: string[];
}

/** Set the features a feature depends on. */
export class SetFeatureDependenciesDto {
  @ApiProperty({ type: [String], description: 'Required feature keys.' })
  @IsArray()
  @IsString({ each: true })
  @Matches(KEY_PATTERN, {
    each: true,
    message: 'requires keys must be lowercase alphanumeric with . _ -',
  })
  requires!: string[];
}

/** Toggle a single feature for a tenant (super-admin). */
export class SetTenantFeatureDto {
  @ApiProperty({ example: 'ai.assistant', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  @Matches(KEY_PATTERN, {
    message: 'featureKey must be lowercase alphanumeric with . _ -',
  })
  featureKey!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}

/** Bulk toggle multiple features for a tenant (super-admin). */
export class BulkSetTenantFeaturesDto {
  @ApiProperty({ type: [SetTenantFeatureDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SetTenantFeatureDto)
  updates!: SetTenantFeatureDto[];
}

/** Catalog listing filters. */
export class QueryFeatureDefinitionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;
}
