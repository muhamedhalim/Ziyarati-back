import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Workflow } from '../../entities/Workflows/Workflow';
import { WorkflowRun } from '../../entities/Workflows/WorkflowRun';

import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';

import { WorkflowService } from './workflow.service';
import { WorkflowActionExecutor } from './workflow-action.executor';
import { WorkflowEventListener } from './workflow-event.listener';
import { WorkflowController } from './workflow.controller';

/**
 * Workflow Engine — a generic Event → Conditions → Actions automation layer.
 *
 * Reuses the existing infrastructure with ZERO duplicated logic: the global
 * EventEmitter2 bus (triggers), QueueService/BullMQ (async execution + delay +
 * retry), and the domain services (Email / WhatsApp / Notifications / AI) for
 * the actions. The `WorkflowProcessor` (worker root) consumes the `workflow`
 * queue and calls WorkflowActionExecutor — both exported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, WorkflowRun]),
    EmailModule,
    WhatsappModule,
    NotificationsModule,
    AiOrchestratorModule,
  ],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowActionExecutor, WorkflowEventListener],
  exports: [WorkflowService, WorkflowActionExecutor],
})
export class WorkflowModule {}
