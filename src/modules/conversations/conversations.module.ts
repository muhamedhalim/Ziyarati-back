import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { ConversationParticipant } from '../../entities/Conversations/ConversationParticipant';
import { Message } from '../../entities/Conversations/Message';
import { MessageAttachment } from '../../entities/Conversations/MessageAttachment';
import { MessageStatusLog } from '../../entities/Conversations/MessageStatusLog';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { User } from '../../entities/Auth&RBAC/User';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { StorageModule } from '../storage/storage.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';

import { ConversationService } from './conversation.service';
import { ConversationParticipantService } from './conversation-participant.service';
import { MessageService } from './message.service';
import { MessageAttachmentService } from './message-attachment.service';
import { MessageStatusService } from './message-status.service';
import { ConversationExecutionService } from './conversation-execution.service';
import { ConversationAnalyticsService } from './conversation-analytics.service';
import { ConversationAiControlService } from './conversation-ai-control.service';
import { ConversationAiTakeoverService } from './conversation-ai-takeover.service';
import { ConversationsSchemaBootstrap } from './conversations-schema.bootstrap';

import { ConversationController } from './conversation.controller';
import { MessageController } from './message.controller';
import { ConversationParticipantController } from './conversation-participant.controller';
import { MessageAttachmentController } from './message-attachment.controller';
import { ConversationAnalyticsController } from './conversation-analytics.controller';

/**
 * Conversations / Messaging Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService (tenant scope), and the global
 * JwtAuthGuard.
 *
 * Message sends are transactional (message + initial SENT status log +
 * `last_message_at`) via ConversationExecutionService — the seam a future
 * channel/queue worker plugs into. Referenced resources (branch/customer/
 * account/user) are registered for tenant-scoped validation.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Conversation,
      ConversationParticipant,
      Message,
      MessageAttachment,
      MessageStatusLog,
      Branch,
      Customer,
      WhatsappAccount,
      User,
      // READ-ONLY: `ai_human_takeover_minutes` (ConversationAiTakeoverService).
      TenantSetting,
    ]),
    StorageModule,
    // Audit records for pausing/resuming the AI. Acyclic: ActivityLogModule imports only TypeORM.
    ActivityLogModule,
  ],
  controllers: [
    ConversationController,
    MessageController,
    ConversationParticipantController,
    MessageAttachmentController,
    ConversationAnalyticsController,
  ],
  providers: [
    ConversationService,
    ConversationParticipantService,
    MessageService,
    MessageAttachmentService,
    MessageStatusService,
    ConversationExecutionService,
    ConversationAnalyticsService,
    ConversationAiControlService,
    ConversationAiTakeoverService,
    ConversationsSchemaBootstrap,
  ],
  exports: [
    ConversationService,
    ConversationAiControlService,
    ConversationAiTakeoverService,
    MessageService,
    MessageStatusService,
    ConversationExecutionService,
  ],
})
export class ConversationsModule {}
