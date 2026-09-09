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
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { RequireAnyPermission } from '../auth/decorators/require-any-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Spec 014 (Clinic Platform Completion) — T172 (US10, contracts/
 * clinic-surfaces.md §F10). The eight queue routes. Reuses the EXISTING
 * `appointments.read` / `appointments.read_own` / `appointments.update`
 * permission slugs — **no new permission is introduced** (FR-G002).
 *
 * `GET /queue` and `GET /queue/branches` additionally accept
 * `appointments.read_own` (a doctor's ownership-scoped grant) so a doctor can
 * reach their own live queue — `PatientQueueService` forces the staff filter
 * to the caller's own StaffProfile in that case, ignoring `dto.staffId`
 * entirely (mirrors `AppointmentsService.findAll`). The seven write routes
 * are UNCHANGED: they still require the tenant-wide `appointments.update`, so
 * a doctor can read but never act on the queue.
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
  list(
    @Query() dto: QueryQueueDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QueueListResult> {
    return this.queue.list(this.ctx.requireTenantId(), user, dto);
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
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  checkIn(
    @Body() dto: CheckInQueueDto,
    @CurrentUser('id') userId: string,
  ): Promise<QueueEntryView> {
    return this.queue.checkIn(this.ctx.requireTenantId(), userId, dto);
  }

  @Post(':id/call')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  call(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<QueueEntryView> {
    return this.queue.call(this.ctx.requireTenantId(), userId, id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<QueueEntryView> {
    return this.queue.start(this.ctx.requireTenantId(), userId, id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<QueueEntryView> {
    return this.queue.complete(this.ctx.requireTenantId(), userId, id);
  }

  @Post(':id/skip')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  skip(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<QueueEntryView> {
    return this.queue.skip(this.ctx.requireTenantId(), userId, id);
  }

  @Post(':id/recall')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  recall(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<QueueEntryView> {
    return this.queue.recall(this.ctx.requireTenantId(), userId, id);
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.APPOINTMENTS_UPDATE)
  noShow(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<QueueEntryView> {
    return this.queue.noShow(this.ctx.requireTenantId(), userId, id);
  }
}
