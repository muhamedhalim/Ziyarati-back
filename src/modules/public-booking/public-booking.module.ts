import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiSessionModule } from '../ai-session/ai-session.module';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { GuestChatModule } from '../guest-chat/guest-chat.module';
import { PublicDiscoveryModule } from '../public-discovery/public-discovery.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrmModule } from '../crm/crm.module';
import { AppointmentModule } from '../appointment/appointment.module';
import { PaymentsModule } from '../payments/payments.module';
import { AiBotActorModule } from '../ai-bot-actor/ai-bot-actor.module';

import { PublicBookingContextService } from './public-booking-context.service';
import { PublicBookingFlowService } from './public-booking-flow.service';
import { PublicBookingController } from './public-booking.controller';

/**
 * Public AI booking — the seam that lets an ANONYMOUS visitor create a real
 * appointment inside the clinic they selected, without ever holding that
 * clinic's tenant or permissions. Now serves BOTH the AI conversational flow
 * (`PublicBookingContextService`, consumed by `AiModule`) and the
 * deterministic step-by-step HTTP flow (T063-T075:
 * `PublicBookingFlowService` + `PublicBookingController`) — the two share
 * the exact same context/session layer, so they converge on one outcome for
 * identical selections (FR-P003).
 *
 * `PublicBookingContextService` deliberately owns NO booking, availability,
 * pricing, customer, payment or notification logic — those stay in
 * `AppointmentsService`, `AvailabilityService`, `CustomerService`,
 * `PaymentLinkService` and the notification pipeline, and are called, never
 * reimplemented. `PublicBookingFlowService` is the thin orchestrator that
 * calls them, for the deterministic flow only.
 *
 * `AiSessionModule` (not `AiModule`) breaks what would otherwise be a cycle:
 * `AiModule` imports THIS module (the AI tool dispatcher needs
 * `PublicBookingContextService`), so this module cannot import `AiModule`
 * back. `AiConversation` is registered locally for the same reason
 * (`ensureConversation` needs to INSERT a row, which only `AiConversationService`
 * — inside `AiModule` — otherwise offers).
 */
@Module({
  imports: [
    AiSessionModule,
    TypeOrmModule.forFeature([AiConversation]),
    forwardRef(() => GuestChatModule),
    PublicDiscoveryModule,
    SchedulingModule,
    CrmModule,
    AppointmentModule,
    PaymentsModule,
    AiBotActorModule,
  ],
  controllers: [PublicBookingController],
  providers: [PublicBookingContextService, PublicBookingFlowService],
  exports: [PublicBookingContextService],
})
export class PublicBookingModule {}
