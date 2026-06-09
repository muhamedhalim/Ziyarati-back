import { PartialType } from '@nestjs/swagger';
import { CreateWhatsappTemplateDto } from './create-whatsapp-template.dto';

/** Partial update of a WhatsApp template. */
export class UpdateWhatsappTemplateDto extends PartialType(
  CreateWhatsappTemplateDto,
) {}
