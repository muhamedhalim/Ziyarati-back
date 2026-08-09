import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { CreateWhatsappTemplateDto } from './create-whatsapp-template.dto';
import { WHATSAPP_TEMPLATE_STATUSES } from '../whatsapp.constants';

/**
 * Partial update of the LOCAL template row. This does not write to Meta —
 * editing a template on Meta is a separate lifecycle that is not implemented.
 *
 * `status` is re-declared here rather than inherited: `CreateWhatsappTemplateDto`
 * deliberately dropped it (a template's initial status is Meta's response, never
 * client input), but the pre-existing review-lifecycle transitions this endpoint
 * supports — draft → pending_review → rejected/disabled — still need it.
 * `approved` remains refused by `assertNotSettingApproved` in the service,
 * whichever entry point it arrives through (GAP-002).
 */
export class UpdateWhatsappTemplateDto extends PartialType(
  CreateWhatsappTemplateDto,
) {
  @ApiPropertyOptional({
    description:
      'Review status. `approved` is always rejected (403) — reachable only through Meta, never client input (GAP-002).',
    enum: WHATSAPP_TEMPLATE_STATUSES,
    example: 'pending_review',
  })
  @IsOptional()
  @IsIn(WHATSAPP_TEMPLATE_STATUSES)
  status?: string;
}
