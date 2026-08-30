import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AppointmentsService } from './appointment.service';
import { AppointmentReviewService } from './appointment-review.service';

import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { QueryAppointmentsDto } from './dto/query-appointments.dto';
import { ChangeAppointmentStatusDto } from './dto/change-appointment-status.dto';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import { AddAppointmentNoteDto } from './dto/add-appointment-note.dto';
import { SetAppointmentServicesDto } from './dto/set-appointment-services.dto';
import { CreateReviewDto } from './dto/create-review.dto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { RequireAnyPermission } from '../auth/decorators/require-any-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { AppointmentActionOrigin } from '../../entities/enums';

// ─── Reusable inline response schema fragments ────────────────────────────────

// The field is `code`, not `errorCode` — this schema documented a name the
// AllExceptionsFilter has never emitted, so clients coded against the docs
// looked for a key that was never there. `context` carries the per-throw
// `AppError.publicContext` (e.g. `reasonCodes` on a booking conflict).
const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    error: { type: 'string' },
    code: { type: 'string', example: 'STAFF_NOT_AVAILABLE' },
    message: { type: 'string' },
    context: { type: 'object', additionalProperties: true },
    path: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const S_APPOINTMENT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    start_at: { type: 'string', format: 'date-time' },
    end_at: { type: 'string', format: 'date-time' },
    status: {
      type: 'string',
      enum: [
        'PENDING_PAYMENT',
        'CONFIRMED',
        'IN_PROGRESS',
        'COMPLETED',
        'CANCELLED',
        'NO_SHOW',
        'RESCHEDULED',
      ],
      example: 'PENDING_PAYMENT',
    },
    total_amount: { type: 'number', example: 250.0, nullable: true },
    currency: { type: 'string', example: 'SAR' },
    source: {
      type: 'string',
      enum: ['PLATFORM', 'WHATSAPP_BOT', 'MANUAL'],
      example: 'MANUAL',
    },
    notes: { type: 'string', nullable: true },
    branch: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
    customer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        full_name: { type: 'string' },
      },
    },
    staff: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
    },
    services: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          price: { type: 'number', example: 120.0 },
          duration_minutes: { type: 'number', example: 30 },
          service: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

const S_APPOINTMENT_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_APPOINTMENT },
    total: { type: 'number', example: 134 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

const S_NOTE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    content: { type: 'string' },
    user: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      nullable: true,
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_TIMELINE = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: [
          'created',
          'status_log',
          'history',
          'note',
          'reschedule',
          'cancellation',
        ],
      },
      at: { type: 'string', format: 'date-time' },
      data: { type: 'object', additionalProperties: true },
    },
  },
};

const S_REVIEW = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    rating: { type: 'number', example: 5 },
    comment: { type: 'string', nullable: true },
    reply: { type: 'string', nullable: true },
    customer: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appointment domain — the clinic's scheduling core.
 *
 * Guards:
 *  - PermissionsGuard → enforces the RBAC permission on each handler;
 *  - ActiveTenantGuard → the clinic must be APPROVED + active.
 *
 * Tenant scoping: the tenantId is read from TenantContext (the authenticated
 * principal) and passed to the service — it is NEVER accepted from the body/URL.
 */
@ApiTags('Appointments')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.APPOINTMENTS)
@Controller('appointments')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class AppointmentController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly reviews: AppointmentReviewService,
    private readonly ctx: TenantContextService,
  ) {}

  // ───────────────────────────── Create ──────────────────────────────────── //

  @ApiOperation({
    summary: 'Book a new appointment',
    description: `
**Protected — requires \`appointments.create\`. Clinic must be active.**

Creates an appointment for a customer with a staff member at a branch,
atomically (appointment + services + initial status log + history in one
transaction).

**What the service validates:**
- Branch, customer, staff and every service belong to the caller's clinic
  (tenant isolation — references from other clinics are rejected as 404).
- Services must be active. Their durations derive \`end_at\` (when \`endAt\`
  is omitted) and their prices snapshot \`total_amount\`.
- **No double-booking:** the staff member must be free for the requested
  window (overlap check, ignoring cancelled / no-show appointments).

**Initial status:** \`PENDING_PAYMENT\`. Drive it forward via the status,
cancel and reschedule endpoints.

**Who can call this:** Owner, Manager, Receptionist, Customer (any role
holding \`appointments.create\`). The WhatsApp bot uses the same path with
\`source = WHATSAPP_BOT\`.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Appointment booked.',
    schema: S_APPOINTMENT,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or neither `endAt` nor any service was provided to derive the duration.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `appointments.create`, or the clinic is not active.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description:
      'Branch, customer, staff, or a service was not found within this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: `
The staff member cannot take this window. Two distinct codes:

- \`STAFF_NOT_AVAILABLE\` — the availability engine refused it. \`context.reasonCodes\`
  is a subset of \`STAFF_INACTIVE\`, \`HOLIDAY\`, \`TIME_OFF\`, \`BLOCKED\`, \`OCCUPIED\`,
  \`OUTSIDE_WORKING_HOURS\`, so a client can show the specific reason.
- \`SLOT_ALREADY_BOOKED\` — the window was free when checked, but a concurrent
  request committed first (the \`appointments_no_overlap\` exclusion constraint).
  Retryable: refresh the available slots and pick again.
    `.trim(),
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.APPOINTMENTS_CREATE)
  create(@Body() dto: CreateAppointmentDto, @CurrentUser('id') userId: string) {
    return this.appointments.create(this.ctx.requireTenantId(), userId, dto);
  }

  // ───────────────────────────── Read ────────────────────────────────────── //

  @ApiOperation({
    summary: 'List appointments (filtered + paginated)',
    description: `
**Protected — requires \`appointments.read\` OR \`appointments.read_own\`. Clinic must be active.**

Returns a paginated list of the clinic's appointments. All filters
(\`status\`, \`branchId\`, \`staffId\`, \`customerId\`, \`from\`/\`to\` date range)
are applied ON TOP OF the mandatory tenant scope.

**Ownership scoping:** a caller who holds only \`appointments.read_own\`
(currently: \`doctor\`) is FORCED to their own StaffProfile's appointments —
\`staffId\` in the query is ignored for them, never a way to widen the scope.

Ordered by \`start_at\` descending (most recent first).

**Who can call this:** Owner, Manager, Receptionist (\`appointments.read\`);
Doctor, own appointments only (\`appointments.read_own\`).

**Tenant scoping:** Only the caller's clinic appointments are ever returned.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Paginated appointments.',
    schema: S_APPOINTMENT_LIST,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_READ_OWN,
  )
  findAll(
    @Query() query: QueryAppointmentsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointments.findAll(this.ctx.requireTenantId(), query, {
      id: user.id,
      permissions: user.permissions,
    });
  }

  @ApiOperation({
    summary: 'Get an appointment by ID',
    description: `
**Protected — requires \`appointments.read\` OR \`appointments.read_own\`. Clinic must be active.**

Returns one appointment with its branch, customer, staff, services and
booking metadata.

**Ownership scoping:** a caller who holds only \`appointments.read_own\`
(currently: \`doctor\`) gets this appointment ONLY if it is assigned to
their own StaffProfile.

**Tenant scoping:** An appointment from another clinic returns 404
(no cross-tenant existence leak). The SAME 404 — not 403 — is returned when
an \`appointments.read_own\` caller requests an appointment assigned to a
different staff member, so existence is never distinguishable from "not
yours".
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Appointment found.', schema: S_APPOINTMENT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_READ_OWN,
  )
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointments.findOne(this.ctx.requireTenantId(), id, {
      id: user.id,
      permissions: user.permissions,
    });
  }

  // ───────────────────────────── Update ──────────────────────────────────── //

  @ApiOperation({
    summary: 'Update an appointment (reassign staff/branch, edit notes)',
    description: `
**Protected — requires \`appointments.update\`. Clinic must be active.**

Updates mutable, non-temporal attributes:
- **Reassign staff** — the new staff member is conflict-checked against
  their existing schedule for the appointment's current window.
- **Move branch** — validated to belong to the same clinic.
- **Edit notes**.

**Out of scope here (use the dedicated endpoints):**
- Date/time → \`POST /appointments/:id/reschedule\` (auditable).
- Services → \`PUT /appointments/:id/services\` (recomputes totals).

Terminal appointments (completed / cancelled / no-show) cannot be updated.

Every change is written to the appointment history.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Appointment updated.', schema: S_APPOINTMENT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description:
      'Appointment, new staff or new branch not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description:
      'Appointment is terminal, or the new staff member has a conflicting booking.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.appointments.update(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Replace the services on an appointment',
    description: `
**Protected — requires \`appointments.update\`. Clinic must be active.**

Replaces the appointment's full service set (idempotent set semantics).
On save, \`end_at\` and \`total_amount\` are recomputed from the new
services' durations and prices (snapshotted at this moment).

Every service must belong to the clinic and be active. Terminal
appointments cannot be modified.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Services replaced; totals recomputed.',
    schema: S_APPOINTMENT,
  })
  @ApiBadRequestResponse({
    description: 'Validation failed (e.g. empty service list).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment or one of the services not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Appointment is in a terminal status.',
    schema: S_ERROR,
  })
  @Put(':id/services')
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  setServices(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetAppointmentServicesDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.appointments.setServices(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto,
    );
  }

  // ─────────────────────────── Status lifecycle ──────────────────────────── //

  @ApiOperation({
    summary: 'Change appointment status',
    description: `
**Protected — requires \`appointments.update\`. Clinic must be active.**

Drives the appointment through its lifecycle, enforcing the state machine:

\`\`\`
PENDING_PAYMENT → CONFIRMED | NO_SHOW
CONFIRMED       → IN_PROGRESS | COMPLETED | NO_SHOW
IN_PROGRESS     → COMPLETED
RESCHEDULED     → CONFIRMED | NO_SHOW
\`\`\`

Illegal transitions are rejected (409). Each change writes an
\`appointment_status_logs\` row **and** an \`appointment_history\` entry
(full audit trail).

**\`CANCELLED\` is not accepted here** — use the cancel endpoint, which
captures reason/actor/refund.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Status changed.', schema: S_APPOINTMENT })
  @ApiBadRequestResponse({
    description:
      'Target is `CANCELLED` (use cancel), or status is already set.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Illegal status transition for the current state.',
    schema: S_ERROR,
  })
  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeAppointmentStatusDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.appointments.changeStatus(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto,
    );
  }

  // ─────────────────────────── Cancellation ──────────────────────────────── //

  @ApiOperation({
    summary: 'Cancel an appointment',
    description: `
**Protected — requires \`appointments.cancel\`. Clinic must be active.**

Cancels an appointment that is not already terminal. Persists an
\`appointment_cancellations\` audit row (reason, who, refund amount), plus
a status log + history entry, and sets the status to \`CANCELLED\`.

The \`refundAmount\` is recorded for audit only — actual refund processing
belongs to the payments domain.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.cancel\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Appointment cancelled.',
    schema: S_APPOINTMENT,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.cancel`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Appointment is already completed/cancelled/no-show.',
    schema: S_ERROR,
  })
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_CANCEL)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelAppointmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.appointments.cancel(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto,
      AppointmentActionOrigin.STAFF,
    );
  }

  // ─────────────────────────── Reschedule ────────────────────────────────── //

  @ApiOperation({
    summary: 'Reschedule an appointment',
    description: `
**Protected — requires \`appointments.reschedule\`. Clinic must be active.**

Moves the appointment to a new time window. If \`newEndAt\` is omitted, the
original duration is preserved. The new window is conflict-checked against
the staff member's other appointments (excluding this one).

Persists an \`appointment_reschedules\` audit row (reason + actor) and an
\`appointment_history\` entry recording the old → new times, then updates
\`start_at\`/\`end_at\`. Terminal appointments cannot be rescheduled.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.reschedule\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Appointment rescheduled.',
    schema: S_APPOINTMENT,
  })
  @ApiBadRequestResponse({
    description: 'Validation failed, or end is not after start.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.reschedule`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description:
      'Appointment is terminal, or the staff member is busy in the new window.',
    schema: S_ERROR,
  })
  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_RESCHEDULE)
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleAppointmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.appointments.reschedule(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto,
      AppointmentActionOrigin.STAFF,
    );
  }

  // ───────────────────────────── Notes ───────────────────────────────────── //

  @ApiOperation({
    summary: 'Add an internal note to an appointment',
    description: `
**Protected — requires \`appointments.update\`. Clinic must be active.**

Attaches a tenant-scoped internal staff note. The author is captured
server-side from the authenticated principal — it is never taken from the
body.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({ description: 'Note added.', schema: S_NOTE })
  @ApiBadRequestResponse({
    description: 'Validation failed (empty content).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @Post(':id/notes')
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddAppointmentNoteDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.appointments.addNote(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto,
    );
  }

  @ApiOperation({
    summary: 'List internal notes for an appointment',
    description: `
**Protected — requires \`appointments.read\` OR \`appointments.read_own\` (own appointment only). Clinic must be active.**

Returns all internal staff notes for the appointment, newest first.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.read\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Notes for the appointment.',
    schema: { type: 'array', items: S_NOTE },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @Get(':id/notes')
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_READ_OWN,
  )
  listNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointments.listNotes(this.ctx.requireTenantId(), id, {
      id: user.id,
      permissions: user.permissions,
    });
  }

  // ───────────────────────────── Timeline ────────────────────────────────── //

  @ApiOperation({
    summary: 'Get the full appointment timeline (audit trail)',
    description: `
**Protected — requires \`appointments.read\` OR \`appointments.read_own\` (own appointment only). Clinic must be active.**

Returns a single chronological stream merged from every audit source:
creation, status logs, history entries, notes, reschedules and
cancellations — each tagged with a \`type\` and \`at\` timestamp.

Ideal for rendering an activity feed on the appointment detail screen.

**Who can call this:** Owner, Manager, Receptionist (\`appointments.read\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Merged, time-ordered timeline.',
    schema: S_TIMELINE,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @Get(':id/timeline')
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_READ_OWN,
  )
  timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointments.getTimeline(this.ctx.requireTenantId(), id, {
      id: user.id,
      permissions: user.permissions,
    });
  }

  // ───────────────────────────── Reminders ───────────────────────────────── //

  @ApiOperation({
    summary: 'Get the reminders scheduled for an appointment',
    description: `
**Protected — requires \`appointments.read\` OR \`appointments.read_own\` (own appointment only). Clinic must be active.**

Returns every reminder row for the appointment (any lead time), in every
state — scheduled, sent, suppressed or failed — with its channel and
reason, projected from \`scheduled_notifications\` (no separate storage).

**Tenant scoping:** An appointment from another clinic returns 404.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @Get(':id/reminders')
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_READ_OWN,
  )
  reminders(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointments.listReminders(this.ctx.requireTenantId(), id, {
      id: user.id,
      permissions: user.permissions,
    });
  }

  // ───────────────────────────── Delete ──────────────────────────────────── //

  @ApiOperation({
    summary: 'Delete an appointment (soft)',
    description: `
**Protected — requires \`appointments.manage_all\`. Clinic must be active.**

Soft-deletes an appointment (sets \`deleted_at\`; the row is retained for
audit). **Only \`CANCELLED\` or \`NO_SHOW\` appointments may be deleted** —
active or completed appointments are preserved for reporting and must be
cancelled first.

**Who can call this:** Owner or Manager (\`appointments.manage_all\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Appointment soft-deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `appointments.manage_all`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description:
      'Appointment is not cancelled/no-show, so it cannot be deleted.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.APPOINTMENTS_MANAGE_ALL)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.appointments.remove(this.ctx.requireTenantId(), userId, id);
  }

  // ───────────────────────────── Reviews ─────────────────────────────────── //

  @ApiOperation({
    summary: 'Create a review for a completed appointment',
    description: `
**Protected — requires \`reviews.create\`. Clinic must be active.**

Creates the customer review for an appointment. Business rules:
- The appointment **must be \`COMPLETED\`** (422 otherwise).
- **One review per appointment** — a second attempt returns 409.
- The review's customer is taken FROM the appointment, never the request.

**Who can call this:** Customer (\`reviews.create\`). Staff roles that hold
the permission may also submit on a customer's behalf.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({ description: 'Review created.', schema: S_REVIEW })
  @ApiBadRequestResponse({
    description: 'Validation failed (rating must be 1–5).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `reviews.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'The appointment has already been reviewed.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'The appointment is not completed yet.',
    schema: S_ERROR,
  })
  @Post(':id/review')
  @RequirePermissions(PERMISSION.REVIEWS_CREATE)
  createReview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.create(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Get the review for an appointment',
    description: `
**Protected — requires \`reviews.read\`. Clinic must be active.**

Returns the single review attached to the appointment (if any).

**Who can call this:** Owner, Manager, Receptionist (\`reviews.read\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'The appointment review.', schema: S_REVIEW })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `reviews.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'No review found for this appointment.',
    schema: S_ERROR,
  })
  @Get(':id/review')
  @RequirePermissions(PERMISSION.REVIEWS_READ)
  getReview(@Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.getForAppointment(this.ctx.requireTenantId(), id);
  }
}
