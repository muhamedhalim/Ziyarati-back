import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { WHATSAPP_TEMPLATE_CATEGORIES } from '../whatsapp.constants';
import { WhatsappTemplateComponentDto } from './create-whatsapp-template.dto';

/**
 * Edit a REJECTED or PAUSED template and send it back to Meta for review.
 *
 * Name and language are not accepted: Meta cannot change them on an existing
 * template. Status is not accepted either — it is whatever Meta says next.
 */
export class ResubmitWhatsappTemplateDto {
  @ApiPropertyOptional({
    enum: WHATSAPP_TEMPLATE_CATEGORIES,
    description:
      'New proposed category. Omitted = keep the current one. Meta still decides the final category.',
  })
  @IsOptional()
  @IsIn(WHATSAPP_TEMPLATE_CATEGORIES)
  category?: string;

  @ApiProperty({
    type: [WhatsappTemplateComponentDto],
    description: 'The complete corrected components (not a patch).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => WhatsappTemplateComponentDto)
  components!: WhatsappTemplateComponentDto[];
}
