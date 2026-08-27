import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTenantTargetsDto {
  @ApiPropertyOptional({
    description:
      'Monthly goal for completed appointments (current UTC calendar month). 0 is allowed (a trivially-met target); omit to leave unchanged.',
    minimum: 0,
    maximum: 100_000,
    example: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  appointmentTarget?: number;

  @ApiPropertyOptional({
    description:
      "Monthly revenue goal, in the clinic's own settings currency (current UTC calendar month). 0 is allowed; omit to leave unchanged.",
    minimum: 0,
    maximum: 100_000_000,
    example: 50000,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000_000)
  revenueTarget?: number;
}
