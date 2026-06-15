import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateWhatsappAccountDto } from './create-whatsapp-account.dto';

/**
 * Updates account credentials/settings. `branchId` and `mode` are immutable
 * (uniqueness is on branch+mode), so they are omitted from the updatable surface.
 */
export class UpdateWhatsappAccountDto extends PartialType(
  OmitType(CreateWhatsappAccountDto, ['branchId', 'mode'] as const),
) {}
