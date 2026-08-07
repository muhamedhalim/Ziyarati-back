import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiConversationAccessService } from '../ai/ai-conversation-access.service';
import { ConversationSessionService } from '../ai-orchestrator/conversation-session.service';

/**
 * The two services that own AI conversation OWNERSHIP and SESSION STATE.
 *
 * They live in their own module purely to break a dependency cycle: the public
 * booking flow needs both (to check that a guest owns the conversation, and to
 * read/write the booking selections), and `AiToolDispatchService` — which lives
 * in `AiModule` — needs the public booking context. Left where they were,
 * `AiModule → PublicBookingModule → AiModule` would close a loop.
 *
 * Both are thin and repo-only (`AiConversation` and nothing else), so hoisting
 * them costs nothing and duplicates nothing. `AiModule` and
 * `AiOrchestratorModule` re-export this module, so every existing consumer
 * resolves them exactly as before.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AiConversation])],
  providers: [AiConversationAccessService, ConversationSessionService],
  exports: [AiConversationAccessService, ConversationSessionService],
})
export class AiSessionModule {}
