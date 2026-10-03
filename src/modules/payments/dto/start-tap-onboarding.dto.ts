import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Starts Tap's hosted onboarding for the caller's clinic. Nothing about the
 * clinic's identity or bank details is accepted here — those are entered on
 * Tap's own page and never reach ZiyaraTech. The only input is the language the
 * hosted page should open in.
 */
export class StartTapOnboardingDto {
  @ApiPropertyOptional({
    description: 'Language of Tap’s hosted onboarding page.',
    enum: ['en', 'ar'],
    example: 'ar',
  })
  @IsOptional()
  @IsIn(['en', 'ar'])
  locale?: 'en' | 'ar';
}
