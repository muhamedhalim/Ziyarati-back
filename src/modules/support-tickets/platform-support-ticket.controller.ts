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
import { AddTicketReplyDto } from './dto/add-ticket-reply.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { TicketActor } from './support-ticket.service';

/**
 * Platform Support Tickets — cross-tenant, every route gated by a
 * `platform.support_tickets.*` permission slug (PermissionsGuard), NOT by
 * `@Roles(SUPER_ADMIN)` anymore. `super_admin` holds every slug via the `'*'`
 * wildcard (PermissionsGuard's own super_admin short-circuit also applies),
 * so this widening is behaviourally invisible to Super Admin — it is what
 * ADMITS Platform Customer Service (`platform_support`, holding only
 * read/triage/reply) without granting it Super Admin's other privileges.
 * `PLATFORM_SUPPORT_TICKETS_CLOSE` is held by NO explicit role — only
 * super_admin, via the wildcard — so the close boundary is enforced
 * dynamically inside SupportTicketService.updateStatus (see
 * assertPlatformStatusAllowed), since one static decorator on this route
 * cannot express "TRIAGE for most values, CLOSE for one value".
 */
@ApiTags('Platform Support Tickets')
@ApiBearerAuth('JWT-auth')
@Controller('platform/support-tickets')
@UseGuards(PermissionsGuard)
export class PlatformSupportTicketController {
  constructor(private readonly ticketsService: SupportTicketService) {}

  /**
   * Real actor attribution — id, name, permissions (for the service's
   * dynamic close-boundary check) and role. Role is `super_admin` when held,
   * else the caller's actual platform role slug (e.g. `platform_support`) —
   * never hardcoded to `super_admin` regardless of who is actually acting.
   */
  private actorFrom(user: AuthenticatedUser): TicketActor {
    const role = user.roles.includes(ROLE.SUPER_ADMIN)
      ? ROLE.SUPER_ADMIN
      : (user.roles[0] ?? undefined);
    return {
      id: user.id,
      email: user.email,
      name: user.fullName,
      permissions: user.permissions,
      role,
    };
  }

  @ApiOperation({ summary: 'Aggregate KPI counts' })
  @ApiOkResponse({
    description: 'Open / in-progress / resolved / urgent counts.',
  })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ)
  @Get('kpis')
  kpis() {
    return this.ticketsService.kpis();
  }

  @ApiOperation({
    summary:
      'List every clinic that has at least one ticket (Support Desk clinic filter, D4)',
    description:
      'Minimal-disclosure clinic list for the Support Desk console — NOT the full tenant directory.',
  })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ)
  @Get('clinics')
  listClinics() {
    return this.ticketsService.listSupportClinics();
  }

  @ApiOperation({
    summary: "List all tenants' support tickets",
    description:
      'Filterable by status/category/priority/tenant, searchable, sorted, server-paginated.',
  })
  @ApiOkResponse({ description: 'Paginated tickets across every tenant.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ)
  @Get()
  list(@Query() query: QuerySupportTicketsDto) {
    return this.ticketsService.listForAdmin(query);
  }

  @ApiOperation({
    summary: 'Get a ticket',
    description:
      'Full detail: tenant identity + contact, creator info, attachment, status history and internal notes.',
  })
  @ApiParam({
    name: 'id',
    description: 'Ticket UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Ticket details.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ)
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.ticketsService.getForAdmin(id);
  }

  @ApiOperation({
    summary: 'Change ticket status',
    description:
      'Covers triage (open/in_progress/waiting_for_tenant/resolved) as well as closing. Closing is ' +
      'restricted to callers holding platform.support_tickets.close (super_admin only) — enforced ' +
      'dynamically inside the service, since this one route serves every target status. Resolved/' +
      'closed timestamps are updated automatically; reopening clears them. Every change is recorded ' +
      'in the event log.',
  })
  @ApiParam({
    name: 'id',
    description: 'Ticket UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Ticket updated.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE)
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketsService.updateStatus(id, this.actorFrom(user), dto);
  }

  @ApiOperation({ summary: 'Change ticket priority' })
  @ApiParam({
    name: 'id',
    description: 'Ticket UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Ticket updated.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE)
  @Patch(':id/priority')
  updatePriority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketPriorityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketsService.updatePriority(id, this.actorFrom(user), dto);
  }

  @ApiOperation({
    summary: 'Add an internal admin note',
    description:
      'Never visible to tenant users — only platform staff can add or read these.',
  })
  @ApiParam({
    name: 'id',
    description: 'Ticket UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Ticket updated with the new note.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY)
  @Post(':id/notes')
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTicketNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketsService.addNote(id, this.actorFrom(user), dto);
  }

  @ApiOperation({
    summary: 'Reply to a ticket (clinic-visible)',
    description:
      'Visible to the clinic in their own ticket timeline. Never changes ticket status.',
  })
  @ApiParam({
    name: 'id',
    description: 'Ticket UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Ticket updated with the new reply.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY)
  @Post(':id/replies')
  addReply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTicketReplyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketsService.addPlatformReply(id, this.actorFrom(user), dto);
  }
}
