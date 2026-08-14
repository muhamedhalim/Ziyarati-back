import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SupportTicket } from '../../entities/SupportTickets/SupportTicket';
import { SupportTicketEvent } from '../../entities/SupportTickets/SupportTicketEvent';

import { SupportTicketService } from './support-ticket.service';
import { SupportTicketController } from './support-ticket.controller';
import { PlatformSupportTicketController } from './platform-support-ticket.controller';
import { StorageModule } from '../storage/storage.module';

/**
 * Support Tickets domain: tenant users file tickets, super-admins triage them
 * platform-wide. Attachments reuse the existing R2 `StorageService` (tenant
 * uploads via the generic `POST /uploads` gateway first, then submit the
 * returned `storageKey` here) rather than a bespoke upload path.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SupportTicket, SupportTicketEvent]), StorageModule],
  controllers: [SupportTicketController, PlatformSupportTicketController],
  providers: [SupportTicketService],
  // Exported so the Platform Control Center reads ticket counts from the
  // service that owns them rather than re-querying `support_tickets`.
  exports: [SupportTicketService],
})
export class SupportTicketsModule {}
