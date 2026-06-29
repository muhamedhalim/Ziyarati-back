import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Non-file fields of the `multipart/form-data` upload request. */
export class UploadObjectDto {
  @ApiProperty({
    description:
      'Logical document category — becomes a path segment in the object key (e.g. `commercial_registration`).',
    example: 'commercial_registration',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  docType!: string;
}
