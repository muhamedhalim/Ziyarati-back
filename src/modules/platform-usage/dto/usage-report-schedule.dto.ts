import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const REPORT_FREQUENCY = ['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'] as const;
export const REPORT_DELIVERY = ['EMAIL', 'WEBHOOK'] as const;
export const REPORT_FORMAT = ['JSON', 'CSV', 'EXCEL'] as const;
export const REPORT_SECTIONS = [
  'usage',
  'growth',
  'topConsumers',
  'exceeded',
  'forecast',
  'recommendations',
  'queue',
  'api',
  'storage',
] as const;

export class CreateUsageReportScheduleDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;

  @ApiProperty({ enum: REPORT_FREQUENCY })
  @IsIn(REPORT_FREQUENCY as unknown as string[]) frequency!: string;

  @ApiPropertyOptional({ description: 'Cron pattern when frequency = CUSTOM.' })
  @IsOptional() @IsString() cron?: string;

  @ApiProperty({ enum: REPORT_DELIVERY })
  @IsIn(REPORT_DELIVERY as unknown as string[]) delivery!: string;

  @ApiProperty({ description: 'Email address or webhook URL.' })
  @IsString() target!: string;

  @ApiPropertyOptional({ enum: REPORT_FORMAT, default: 'JSON' })
  @IsOptional() @IsIn(REPORT_FORMAT as unknown as string[]) format?: string;

  @ApiPropertyOptional({ enum: REPORT_SECTIONS, isArray: true })
  @IsOptional() @IsArray() @IsIn(REPORT_SECTIONS as unknown as string[], { each: true })
  sections?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class UpdateUsageReportScheduleDto extends PartialType(CreateUsageReportScheduleDto) {}
