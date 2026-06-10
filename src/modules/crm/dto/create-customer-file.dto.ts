import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Register a customer file. METADATA ONLY — the binary lives in external storage;
 * `file_url` is its location/path. The system does not store raw binary here.
 */
export class CreateCustomerFileDto {
  @ApiProperty({ description: 'Stored location / URL of the file.', example: 'https://cdn.example.com/files/abc.pdf' })
  @IsString()
  @MaxLength(2048)
  file_url!: string;

  @ApiPropertyOptional({ description: 'Original file name.', example: 'lab-result.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  file_name?: string;

  @ApiPropertyOptional({ description: 'MIME / file type.', example: 'application/pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  file_type?: string;
}
