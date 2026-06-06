import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateTenantSettingsDto {
  /** How bookings are confirmed: automatically or manually by staff. */
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  bookingConfirmation?: string;

  @IsOptional()
  @IsBoolean()
  paymentRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720) // up to 30 days
  cancellationHours?: number;

  /** Delay before the post-appointment feedback request (default 360 = 6h). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080) // up to 7 days
  feedbackDelayMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  defaultLanguage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  botEnabled?: boolean;
}
