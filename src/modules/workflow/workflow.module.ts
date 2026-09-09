import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Workflow } from '../../entities/Workflows/Workflow';
import { WorkflowRun } from '../../entities/Workflows/WorkflowRun';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';

import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

import { WorkflowService } from './workflow.service';
import { WorkflowActionExecutor } from './workflow-action.executor';
import { WorkflowRecipientResolver } from './workflow-recipient.resolver';
import { WorkflowEventListener } from './workflow-event.listener';
import { WorkflowController } from './workflow.controller';

/**
 * Workflow Engine — a generic Event → Conditions → Actions automation layer.
 *
 * Reuses the existing infrastructure with ZERO duplicated logic: the global
 * EventEmitter2 bus (triggers), QueueService/BullMQ (async execution + delay +
 * retry), and the domain services (Email / WhatsApp, including its template
 * system) for the actions. `Customer`/`StaffProfile` are read-only here,
 * purely to resolve an action's `recipientType` to a real phone/email — see
 * `WorkflowRecipientResolver`. The `WorkflowProcessor` (worker root) consumes
 * the `workflow` queue and calls WorkflowActionExecutor — both exported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, WorkflowRun, Customer, StaffProfile]),
    EmailModule,
    WhatsappModule,
  ],
  controllers: [WorkflowController],
  providers: [
    WorkflowService,
    WorkflowActionExecutor,
    WorkflowRecipientResolver,
    WorkflowEventListener,
  ],
  exports: [WorkflowService, WorkflowActionExecutor],
})
export class WorkflowModule {}
