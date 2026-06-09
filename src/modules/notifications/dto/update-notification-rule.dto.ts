import { PartialType } from '@nestjs/swagger';
import { CreateNotificationRuleDto } from './create-notification-rule.dto';

/** Partial update of a notification rule. */
export class UpdateNotificationRuleDto extends PartialType(
  CreateNotificationRuleDto,
) {}
