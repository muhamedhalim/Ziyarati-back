import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import {
  PatientQueueService,
  QueueListResult,
  QueueEntryView,
} from './patient-queue.service';
import { CheckInQueueDto } from './dto/check-in-queue.dto';
import { QueryQueueDto } from './dto/query-queue.dto';
import { Branch } from '../../entities/SaaS-Core/Branch';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireAnyPermission } from '../auth/decorators/require-any-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION, canViewAppointmentFinancials } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  redactQueueEntryFinancials,
  redactQueueListFinancials,
} from './patient-queue-financial-redaction';

/**
 * Spec 014 (Clinic Platform Completion) — T172 (US10, contracts/
 * clinic-surfaces.md §F10). The eight queue routes. Originally reused only
 * the EXISTING `appointments.read` / `appointments.read_own` /
 * `appointments.update` permission slugs (FR-G002); the Nurse role adds
 * `appointments.status.update` as a second admission on the seven write
 * routes below.
 *
 * `GET /queue` and `GET /queue/branches` additionally accept
 * `appointments.read_own` (a doctor's ownership-scoped grant) so a doctor can
 * reach their own live queue — `PatientQueueService` forces the staff filter
 * to the caller's own StaffProfile in that case, ignoring `dto.staffId`
 * entirely (mirrors `AppointmentsService.findAll`). The seven write routes
 * admit `appointments.update` OR `appointments.status.update` — the latter
 * is the queue/status-lifecycle slice carved out for Nurse (see that
 * permission's own docblock in rbac.constants.ts): a nurse can run check-in/
 * call/start/complete/skip/recall/no-show, but still cannot reassign a
 * doctor/branch (`PATCH /appointments/:id`) or replace services, both of
 * which stay gated to the tenant-wide `appointments.update` alone.
 *
 * A doctor also holds `appointments.status.update` (with `read_own`, never the
 * tenant-wide `read`/`update`), so they run THEIR OWN queue — but the slug
 * alone would let them drive another doctor's entry by UUID. The write routes
 * therefore confine such a caller to appointments assigned to their own
 * StaffProfile (`isStatusWriteScopedToOwnStaff` /
 * `StaffScopeService.assertMayDriveAppointment`, enforced in
 * `PatientQueueService` before any state is claimed): anyone else's entry or
 * appointment is a 404, identical to a missing one. A nurse (tenant-wide read)
 * and every `appointments.update` holder are not confined.
 *
 * Tenant scoping: `tenantId` is read from `TenantContext`, never from the
 * body/URL. Branch scoping (FR-Q014) and cross-tenant 404-not-403 are both
 * enforced inside `PatientQueueService`.
 */
@ApiTags('Patient Queue')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.APPOINTMENTS)
@Controller('queue')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class PatientQueueController {
  constructor(
    private readonly queue: PatientQueueService,
    private readonly ctx: TenantContextService,
  ) {}

  @Get()
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_READ_OWN,
  )
  async list(
    @Query() dto: QueryQueueDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueListResult> {
    const result = await this.queue.list(
      this.ctx.requireTenantId(),
      user,
      dto,
    );
    return redactQueueListFinancials(
      result,
      canViewAppointmentFinancials(user.permissions),
    );
  }

  /** The branches this caller may pick in the queue's branch selector (FR-Q014). */
  @Get('branches')
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_READ_OWN,
  )
  myBranches(@CurrentUser('id') userId: string): Promise<Branch[]> {
    return this.queue.myBranches(this.ctx.requireTenantId(), userId);
  }

  @Post('check-in')
  @HttpCode(HttpStatus.CREATED)
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
  )
  async checkIn(
    @Body() dto: CheckInQueueDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueEntryView> {
    const view = await this.queue.checkIn(
      this.ctx.requireTenantId(),
      user.id,
      dto,
    );
    return redactQueueEntryFinancials(
      view,
      canViewAppointmentFinancials(user.permissions),
    );
  }

  @Post(':id/call')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
  )
  async call(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueEntryView> {
    const view = await this.queue.call(
      this.ctx.requireTenantId(),
      user.id,
      id,
    );
    return redactQueueEntryFinancials(
      view,
      canViewAppointmentFinancials(user.permissions),
    );
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
  )
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueEntryView> {
    const view = await this.queue.start(
      this.ctx.requireTenantId(),
      user.id,
      id,
    );
    return redactQueueEntryFinancials(
      view,
      canViewAppointmentFinancials(user.permissions),
    );
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
  )
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueEntryView> {
    const view = await this.queue.complete(
      this.ctx.requireTenantId(),
      user.id,
      id,
    );
    return redactQueueEntryFinancials(
      view,
      canViewAppointmentFinancials(user.permissions),
    );
  }

  @Post(':id/skip')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
  )
  async skip(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueEntryView> {
    const view = await this.queue.skip(
      this.ctx.requireTenantId(),
      user.id,
      id,
    );
    return redactQueueEntryFinancials(
      view,
      canViewAppointmentFinancials(user.permissions),
    );
  }

  @Post(':id/recall')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
  )
  async recall(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueEntryView> {
    const view = await this.queue.recall(
      this.ctx.requireTenantId(),
      user.id,
      id,
    );
    return redactQueueEntryFinancials(
      view,
      canViewAppointmentFinancials(user.permissions),
    );
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
  )
  async noShow(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueEntryView> {
    const view = await this.queue.noShow(
      this.ctx.requireTenantId(),
      user.id,
      id,
    );
    return redactQueueEntryFinancials(
      view,
      canViewAppointmentFinancials(user.permissions),
    );
  }
}
