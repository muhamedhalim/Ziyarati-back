import { Module } from '@nestjs/common';

import { AiSessionModule } from '../ai-session/ai-session.module';
import { PublicBookingContextService } from './public-booking-context.service';

/**
 * Public AI booking — the seam that lets an ANONYMOUS visitor create a real
 * appointment inside the clinic they selected, without ever holding that
 * clinic's tenant or permissions.
 *
 * Owns exactly one thing: resolving the booking context (which clinic, which
 * branch, which selections) from persisted session state plus a live database
 * check. It deliberately owns NO booking, availability, pricing, customer,
 * payment or notification logic — those stay in `AppointmentsService`,
 * `AvailabilityService`, `CustomerService`, `PaymentLinkService` and the
 * notification pipeline, and are called, never reimplemented.
 *
 * Imports only `AiSessionModule` — the conversation ownership check
 * (`AiConversationAccessService`) and the session store
 * (`ConversationSessionService`). Those are the same session rows the rest of
 * the AI stack reads, so the selections a tool records are the selections the
 * next turn sees. Depending on that narrow module rather than on `AiModule` is
 * what lets `AiModule` import THIS module (the dispatcher needs it) without
 * closing a dependency cycle.
 */
@Module({
  imports: [AiSessionModule],
  providers: [PublicBookingContextService],
  exports: [PublicBookingContextService],
})
export class PublicBookingModule {}
