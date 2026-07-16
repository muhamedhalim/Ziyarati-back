import { PartialType } from '@nestjs/swagger';
import { CreateWhatsappAccountDto } from './create-whatsapp-account.dto';

/**
 * Updates account settings (branch binding, mode, default, active).
 *
 * `branchId` is now updatable: with the old UNIQUE(branch, mode) constraint gone
 * and branch nullable, re-scoping a connected number between a branch and the
 * whole tenant is a legitimate operator action that no longer risks a collision.
 *
 * Credentials (`accessToken`, `wabaId`, `phoneNumberId`) are NOT part of this
 * surface — see CreateWhatsappAccountDto. They change only by re-running
 * Embedded Signup, which re-proves ownership with Meta.
 */
export class UpdateWhatsappAccountDto extends PartialType(CreateWhatsappAccountDto) {}
