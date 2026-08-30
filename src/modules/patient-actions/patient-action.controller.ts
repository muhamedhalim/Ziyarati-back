import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';
import { AppError, ErrorCode } from '../../common/errors';
import { PatientActionPurpose } from '../../entities/enums';

import { PatientActionLinkService } from './patient-action-link.service';
import { PatientCancellationService } from './patient-cancellation.service';
import { PatientRescheduleService } from './patient-reschedule.service';
import { ConfirmCancellationDto } from './dto/confirm-cancellation.dto';
import { ConfirmRescheduleDto } from './dto/confirm-reschedule.dto';
import { RescheduleAvailabilityQueryDto } from './dto/reschedule-availability-query.dto';
import {
  PATIENT_ACTION_LINK_CONFIRM_THROTTLE,
  PATIENT_ACTION_LINK_RESOLVE_THROTTLE,
} from './patient-action.constants';

/**
 * Spec 014 (Clinic Platform Completion) — T031 (US1), contracts/
 * public-surfaces.md §A. `@Public()`: authorised by the action-link token
 * itself, not a tenant principal — see T026A's entitlement decision. Every
 * refusal (unknown/expired/consumed/altered/cross-tenant token) is the
 * SAME 404, never disclosing which condition applied.
 */
@ApiTags('Public — Patient Actions')
@Controller('public/appointments/action')
export class PatientActionController {
  constructor(
    private readonly links: PatientActionLinkService,
    private readonly cancellation: PatientCancellationService,
    private readonly reschedule: PatientRescheduleService,
  ) {}

  @Public()
  @Throttle(PATIENT_ACTION_LINK_RESOLVE_THROTTLE)
  @Get(':token')
  async resolve(@Param('token') token: string) {
    const link = await this.links.resolve(token);
    if (!link) this.throwNotFound();

    const appointment = link.appointment;
    const cancelEligibility = await this.cancellation.describeCancelEligibility(
      link.tenant.id,
      appointment,
    );
    const rescheduleEligibility = await this.reschedule.describeRescheduleEligibility(
      link.tenant.id,
      appointment,
    );

    return {
      clinicName: link.tenant.name,
      branchName: appointment.branch?.name,
      serviceNames: (appointment.services ?? []).map((s) => s.service?.name),
      staffName: appointment.staff?.user?.full_name,
      startAt: appointment.start_at,
      endAt: appointment.end_at,
      timezone: appointment.branch?.timezone,
      status: appointment.status,
      allowed: {
        cancel: cancelEligibility.allowed,
        reschedule: rescheduleEligibility.allowed,
      },
      // Window/terminal/past are the SAME rule for both actions (FR-R009
      // shares FR-C007's basis), so the two agree whenever either is
      // blocked for one of those three reasons. The only reason that can
      // differ per-action is DISABLED_BY_CLINIC (FR-R015: independently
      // switchable) — when the two genuinely disagree, cancel's reason
      // wins here since `allowed.cancel`/`allowed.reschedule` remain the
      // authoritative per-action flags for the frontend either way.
      blockedReason: cancelEligibility.blockedReason ?? rescheduleEligibility.blockedReason,
      clinicContact: {
        phone: link.tenant.contact_phone,
        email: link.tenant.contact_email,
      },
    };
  }

  @Public()
  @Throttle(PATIENT_ACTION_LINK_RESOLVE_THROTTLE)
  @Get(':token/availability')
  async availability(
    @Param('token') token: string,
    @Query() query: RescheduleAvailabilityQueryDto,
  ) {
    const link = await this.links.resolve(token);
    if (!link || link.purpose !== PatientActionPurpose.RESCHEDULE) this.throwNotFound();

    return this.reschedule.getAvailability(
      link.tenant.id,
      link.appointment,
      query.from,
      query.to,
    );
  }

  @Public()
  @SkipCsrf()
  @Throttle(PATIENT_ACTION_LINK_CONFIRM_THROTTLE)
  @Post(':token/reschedule')
  @HttpCode(HttpStatus.OK)
  async confirmReschedule(
    @Param('token') token: string,
    @Body() dto: ConfirmRescheduleDto,
  ) {
    const link = await this.links.resolve(token);
    if (!link || link.purpose !== PatientActionPurpose.RESCHEDULE) this.throwNotFound();

    try {
      const rescheduled = await this.reschedule.rescheduleViaLink(
        link.tenant.id,
        link,
        dto.startAt,
      );
      return {
        status: rescheduled.status,
        startAt: rescheduled.start_at,
        endAt: rescheduled.end_at,
      };
    } catch (err) {
      // FR-R007 — a slot taken (or a window that closed) between display
      // and confirmation is refused WITH refreshed availability, so the
      // client can offer another time immediately rather than making the
      // patient re-open the link.
      if (err instanceof AppError && err.statusCode === HttpStatus.CONFLICT) {
        const fresh = await this.reschedule.getAvailability(
          link.tenant.id,
          link.appointment,
          new Date().toISOString().slice(0, 10),
          new Date(Date.now() + 14 * 24 * 3600_000).toISOString().slice(0, 10),
        );
        throw new AppError(err.code, {
          message: err.message,
          status: err.statusCode,
          publicContext: { ...err.publicContext, slots: fresh.slots },
        });
      }
      throw err;
    }
  }

  @Public()
  @SkipCsrf()
  @Throttle(PATIENT_ACTION_LINK_CONFIRM_THROTTLE)
  @Post(':token/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('token') token: string, @Body() dto: ConfirmCancellationDto) {
    const link = await this.links.resolve(token);
    if (!link || link.purpose !== PatientActionPurpose.CANCEL) this.throwNotFound();

    // Re-checks eligibility server-side even when the GET's `allowed.cancel`
    // was false — the window/state may have changed since, and a stale
    // client read must never be trusted for the write.
    const cancelled = await this.cancellation.cancelViaLink(
      link.tenant.id,
      link,
      dto.reason,
    );

    return {
      status: 'CANCELLED',
      startAt: cancelled.start_at,
      message: 'Your appointment has been cancelled.',
    };
  }

  private throwNotFound(): never {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: 'This link is invalid or no longer active.',
    });
  }
}
