import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Identifies a single private object by its storage key (query param). */
export class ObjectKeyDto {
  @ApiProperty({
    description:
      'Storage key returned by `POST /uploads` (e.g. `<tenantId>/license/<uuid>.pdf`). Not a URL.',
    example: 'a3f1.../license/8c2e....pdf',
    maxLength: 1024,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1024)
  key!: string;
}
