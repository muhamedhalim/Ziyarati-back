import { PartialType } from '@nestjs/swagger';
import { CreateWhatsappWebhookDto } from './create-whatsapp-webhook.dto';

/** Partial update of a webhook log entry (e.g. flipping `processed`). */
export class UpdateWhatsappWebhookDto extends PartialType(
  CreateWhatsappWebhookDto,
) {}
