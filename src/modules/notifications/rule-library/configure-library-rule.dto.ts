import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Settings of a ready-made rule. Everything is optional and nothing here switches
 * the rule on (that is the separate, guarded enable action). The tenant is never
 * read from the body — it comes from the authenticated request.
 */
export class ConfigureLibraryRuleDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'WhatsApp template to send (must belong to the clinic and be ready). `null` clears it, which also switches the rule off.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  whatsappTemplateId?: string | null;

  @ApiPropertyOptional({
    description: 'Delay in minutes; the allowed range depends on the rule.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080)
  delayMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Typed settings: `sendWindow {startHour,endHour}`, `inactivityDays`, `cooldownDays`, `dailyCap`. Unknown keys are refused.',
  })
  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;
}
