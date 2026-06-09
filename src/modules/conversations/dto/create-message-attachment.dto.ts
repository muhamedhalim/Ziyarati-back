import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Stores attachment METADATA for a message (no file storage implementation).
 * The file itself is uploaded to your storage provider separately; pass the
 * resulting URL/metadata here.
 */
export class CreateMessageAttachmentDto {
  @ApiPropertyOptional({
    description: 'URL of the already-uploaded file (storage handled elsewhere).',
    example: 'https://storage.example.com/wa/media/abc.jpg',
  })
  @IsOptional()
  @IsString()
  fileUrl?: string;

  @ApiPropertyOptional({
    description: 'MIME / file type.',
    example: 'image/jpeg',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  fileType?: string;

  @ApiPropertyOptional({
    description: 'Original file name.',
    example: 'xray-result.jpg',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}
