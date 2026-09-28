import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBranchDto {
  @ApiProperty({
    description: 'Display name for this branch location.',
    example: 'Riyadh - Olaya Branch',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Full street address of the branch.',
    example: 'King Fahad Rd, Olaya District, Riyadh 12211',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({
    description:
      'Human-readable city / area of the branch, in any language (e.g. "Riyadh", "الرياض", "Nasr City"). Resolved against the shared `cities` lookup — an existing city is reused, an unknown one is created — and persisted as the branch `city_id`, which the public booking site reads. Cannot be combined with `cityId`.',
    example: 'Riyadh',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    description:
      'City reference UUID (FK to cities lookup table). Prefer `city` unless you already hold the id.',
    example: 'c1d2e3f4-0000-0000-0000-000000000050',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional({
    description: 'Branch landline or main phone number.',
    example: '+966112345678',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    description:
      'Branch-specific WhatsApp number. When set, this branch runs its own independent WhatsApp AI chatbot instance for appointment bookings. Leave empty to use the clinic-level configuration.',
    example: '+966501234567',
    maxLength: 20,
  })
  /** Branch-level WhatsApp number — each branch runs its own WhatsApp system. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsappPhone?: string;

  @ApiPropertyOptional({
    description:
      'IANA timezone identifier for this branch. Used for scheduling and notifications. Defaults to the clinic\'s `defaultTimezone` if not set.',
    example: 'Asia/Riyadh',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
