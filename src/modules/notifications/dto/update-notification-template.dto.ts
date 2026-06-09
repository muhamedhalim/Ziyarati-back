import { PartialType } from '@nestjs/swagger';
import { CreateNotificationTemplateDto } from './create-notification-template.dto';

/** Partial update of a notification template. */
export class UpdateNotificationTemplateDto extends PartialType(
  CreateNotificationTemplateDto,
) {}
