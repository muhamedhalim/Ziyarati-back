import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { SupportTicketService } from './support-ticket.service';
import { QuerySupportTicketsDto } from './dto/query-support-tickets.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { UpdateTicketPriorityDto } from './dto/update-ticket-priority.dto';
import { AddTicketNoteDto } from './dto/add-ticket-note.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ROLE } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Platform Support Tickets — super-admin only, across every tenant. Follows the
 * platform-monitoring convention: `RolesGuard` + `@Roles(ROLE.SUPER_ADMIN)`, no
 * tenant context involved (a super-admin has `tenantId === null`).
 */
@ApiTags('Platform Support Tickets')
@ApiBearerAuth('JWT-auth')
@Controller('platform/support-tickets')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformSupportTicketController {
  constructor(private readonly ticketsService: SupportTicketService) {}

  @ApiOperation({ summary: 'Aggregate KPI counts (super-admin)' })
  @ApiOkResponse({ description: 'Open / in-progress / resolved / urgent counts.' })
  @Get('kpis')
  kpis() {
    return this.ticketsService.kpis();
  }

  @ApiOperation({
    summary: 'List all tenants\' support tickets (super-admin)',
    description: 'Filterable by status/category/priority/tenant, searchable, sorted, server-paginated.',
  })
  @ApiOkResponse({ description: 'Paginated tickets across every tenant.' })
  @Get()
  list(@Query() query: QuerySupportTicketsDto) {
    return this.ticketsService.listForAdmin(query);
  }

  @ApiOperation({
    summary: 'Get a ticket (super-admin)',
    description: 'Full detail: tenant + creator info, attachment, status history and internal admin notes.',
  })
  @ApiParam({ name: 'id', description: 'Ticket UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Ticket details.' })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.ticketsService.getForAdmin(id);
  }

  @ApiOperation({
    summary: 'Change ticket status',
    description:
      'Covers Resolve (status=resolved) and Reopen (status=open) as well as any other transition. Resolved/closed timestamps are updated automatically; reopening clears them. Every change is recorded in the event log.',
  })
  @ApiParam({ name: 'id', description: 'Ticket UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Ticket updated.' })
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketsService.updateStatus(id, { id: user.id, email: user.email }, dto);
  }

  @ApiOperation({ summary: 'Change ticket priority' })
  @ApiParam({ name: 'id', description: 'Ticket UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Ticket updated.' })
  @Patch(':id/priority')
  updatePriority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketPriorityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketsService.updatePriority(id, { id: user.id, email: user.email }, dto);
  }

  @ApiOperation({
    summary: 'Add an internal admin note',
    description: 'Never visible to tenant users — only super-admins can add or read these.',
  })
  @ApiParam({ name: 'id', description: 'Ticket UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Ticket updated with the new note.' })
  @Post(':id/notes')
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTicketNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketsService.addNote(id, { id: user.id, email: user.email }, dto);
  }
}
