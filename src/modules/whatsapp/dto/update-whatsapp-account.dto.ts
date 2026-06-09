import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateWhatsappAccountDto } from './create-whatsapp-account.dto';

/**
 * Updates account credentials/settings. `branchId` is immutable (one account
 * per branch), so it is omitted from the updatable surface.
 */
export class UpdateWhatsappAccountDto extends PartialType(
  OmitType(CreateWhatsappAccountDto, ['branchId'] as const),
) {}
