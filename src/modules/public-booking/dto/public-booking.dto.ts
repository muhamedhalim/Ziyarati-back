import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PHONE_MESSAGE, PHONE_PATTERN } from '../../../common/utils/phone.util';

/**
 * `POST /public/booking/session` — both fields optional, so a body-less call (every existing
 * caller) behaves exactly as before.
 */
export class BookingSessionDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "The chat widget's conversation. Adopted as the booking session ONLY if it is this guest's own; anything else is ignored.",
  })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({
    description:
      'Start a brand-new conversation instead of resuming the current one.',
  })
  @IsOptional()
  @IsBoolean()
  fresh?: boolean;
}

/** contracts/public-surfaces.md §B `POST /public/booking/select/clinic`. */
export class SelectClinicDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clinicId!: string;
}

/** `POST /public/booking/select/branch`. */
export class SelectBranchDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  branchId!: string;
}

/** `POST /public/booking/select/service`. */
export class SelectServiceDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  serviceIds!: string[];
}

/** `POST /public/booking/select/doctor`. */
export class SelectDoctorDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  staffId!: string;
}

/** `POST /public/booking/select/slot`. */
export class SelectSlotDto {
  @ApiProperty({ description: 'ISO-8601 start time.' })
  @IsISO8601()
  startAt!: string;
}

/** `GET /public/booking/availability` query. */
export class PublicBookingAvailabilityQueryDto {
  @ApiProperty({ description: 'Start date (YYYY-MM-DD).' })
  @IsDateString()
  from!: string;

  @ApiProperty({ description: 'End date (YYYY-MM-DD), capped server-side.' })
  @IsDateString()
  to!: string;
}

/** `POST /public/booking/confirm`. */
export class ConfirmBookingDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @ApiProperty({ maxLength: 32 })
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasInsurance?: boolean;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
