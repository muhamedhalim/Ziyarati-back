import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Register file METADATA only. No storage provider is implemented here —
 * `file_url` is the opaque storage reference (S3/MinIO/etc. handled elsewhere).
 */
export class CreateFileUploadDto {
  @ApiProperty({ description: 'Storage reference / URL of the file.', example: 'https://cdn.example.com/u/abc.pdf' })
  @IsString()
  @MaxLength(2048)
  file_url!: string;

  @ApiPropertyOptional({ description: 'Original file name.', example: 'report.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  file_name?: string;

  @ApiPropertyOptional({ description: 'MIME / file type.', example: 'application/pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  file_type?: string;

  @ApiPropertyOptional({ description: 'File size in bytes.', example: 248000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  file_size?: number;
}
