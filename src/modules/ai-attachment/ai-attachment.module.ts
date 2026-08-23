import { Module } from '@nestjs/common';

import { AiAttachmentStagingService } from './ai-attachment-staging.service';

/**
 * The staging half of chat attachments, deliberately its own tiny module.
 *
 * Two modules need it and they sit on opposite sides of a would-be cycle:
 * `GuestChatModule` writes staged descriptors (upload), and `AiModule` reads
 * them (the turn that redeems one). `GuestChatModule` already has to import
 * `AiModule` for `AiProviderFactory` (the vision pass), so putting the staging
 * service in either of them would close a loop. It lives here instead and
 * depends on nothing but the globally-provided `AppRedisService`.
 */
@Module({
  providers: [AiAttachmentStagingService],
  exports: [AiAttachmentStagingService],
})
export class AiAttachmentModule {}
