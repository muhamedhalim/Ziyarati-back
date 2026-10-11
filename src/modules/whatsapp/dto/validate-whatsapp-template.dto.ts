import { IsArray, IsIn, IsOptional, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { WhatsappTemplateComponentDto } from './create-whatsapp-template.dto';
import { WHATSAPP_TEMPLATE_CATEGORIES } from '../whatsapp.constants';

/**
 * Dry-run of the pre-submission checks. Deliberately narrower than
 * `CreateWhatsappTemplateDto`: name/language/account are not part of the
 * content rules, and a draft being typed has no valid name yet — requiring one
 * would make the endpoint answer 400 on every keystroke before the author
 * reaches the body.
 */
export class ValidateWhatsappTemplateDto {
  @ApiPropertyOptional({ enum: WHATSAPP_TEMPLATE_CATEGORIES })
  @IsOptional()
  @IsIn(WHATSAPP_TEMPLATE_CATEGORIES)
  category?: string;

  @ApiProperty({ type: [WhatsappTemplateComponentDto] })
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => WhatsappTemplateComponentDto)
  components!: WhatsappTemplateComponentDto[];
}
