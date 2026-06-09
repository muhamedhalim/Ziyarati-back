import { PartialType } from '@nestjs/swagger';
import { CreateWhatsappContactDto } from './create-whatsapp-contact.dto';

/** Partial update of a WhatsApp contact. */
export class UpdateWhatsappContactDto extends PartialType(
  CreateWhatsappContactDto,
) {}
