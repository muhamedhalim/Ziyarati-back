import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';

import { GuestSessionService } from '../guest-chat/guest-session.service';
import { readGuestTokenCookie } from '../guest-chat/guest-token.util';

import { PublicBookingContextService } from './public-booking-context.service';
import {
  PublicBookingFlowService,
  type GuestPrincipal,
} from './public-booking-flow.service';
import {
  BookingSessionDto,
  ConfirmBookingDto,
  PublicBookingAvailabilityQueryDto,
  SelectBranchDto,
  SelectClinicDto,
  SelectDoctorDto,
  SelectServiceDto,
  SelectSlotDto,
} from './dto/public-booking.dto';
import {
  PUBLIC_AVAILABILITY_THROTTLE,
  PUBLIC_BOOKING_CONFIRM_THROTTLE,
} from './public-booking.throttle';

const BOOKING_SESSION_COOKIE = 'booking_session_id';

/**
 * Spec 014 (Clinic Platform Completion) — T068 (S4). The deterministic
 * step-by-step counterpart to the AI conversational public booking flow —
 * `contracts/public-surfaces.md` §B's 11 routes. Every route is `@Public()`;
 * no route accepts a tenant, branch, service, staff or appointment
 * identifier as an AUTHORIZATION input — selections are read back from the
 * server-owned session (`PublicBookingContextService`), never trusted from
 * the caller.
 *
 * T026A entitlement decision: PLATFORM_AND_PUBLIC_SURFACES (no tenant
 * principal exists to gate a feature against) — see
 * `controller-entitlement-coverage.spec.ts`.
 */
@ApiTags('Public — Booking')
@Controller('public/booking')
export class PublicBookingController {
  constructor(
    private readonly guestSessions: GuestSessionService,
    private readonly bookingContext: PublicBookingContextService,
    private readonly flow: PublicBookingFlowService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Post('session')
  @HttpCode(HttpStatus.OK)
  async session(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: BookingSessionDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res, {
      adoptConversationId: dto?.conversationId,
      fresh: dto?.fresh === true,
    });
    const session = await this.flow.getSelection(
      principal.tenantId,
      conversationId,
      principal,
    );
    // `conversationId` and `guestId` let the chat widget resume the SAME conversation the
    // selections now live on (both are already the caller's own: the id is a conversation this
    // guest owns, the guest id is the identity `POST /public/guest/session` returns too).
    return { selection: session, conversationId, guestId: principal.id };
  }

  @Public()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Get('selection')
  async selection(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { conversationId, principal } = await this.resolve(req, res);
    const session = await this.flow.getSelection(
      principal.tenantId,
      conversationId,
      principal,
    );
    return { selection: session };
  }

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Post('select/clinic')
  @HttpCode(HttpStatus.OK)
  async selectClinic(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SelectClinicDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res);
    await this.flow.selectClinic(principal.tenantId, conversationId, principal, dto.clinicId);
    return { status: 'ok' };
  }

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Post('select/branch')
  @HttpCode(HttpStatus.OK)
  async selectBranch(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SelectBranchDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res);
    await this.flow.selectBranch(principal.tenantId, conversationId, principal, dto.branchId);
    return { status: 'ok' };
  }

  @Public()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Get('services')
  async services(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { conversationId, principal } = await this.resolve(req, res);
    const services = await this.flow.listServices(principal.tenantId, conversationId, principal);
    return { services };
  }

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Post('select/service')
  @HttpCode(HttpStatus.OK)
  async selectService(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SelectServiceDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res);
    await this.flow.selectService(
      principal.tenantId,
      conversationId,
      principal,
      dto.serviceIds,
    );
    return { status: 'ok' };
  }

  @Public()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Get('doctors')
  async doctors(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { conversationId, principal } = await this.resolve(req, res);
    const doctors = await this.flow.listDoctors(principal.tenantId, conversationId, principal);
    return { doctors };
  }

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Post('select/doctor')
  @HttpCode(HttpStatus.OK)
  async selectDoctor(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SelectDoctorDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res);
    await this.flow.selectDoctor(principal.tenantId, conversationId, principal, dto.staffId);
    return { status: 'ok' };
  }

  @Public()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Get('availability')
  async availability(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() query: PublicBookingAvailabilityQueryDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res);
    return this.flow.availability(
      principal.tenantId,
      conversationId,
      principal,
      query.from,
      query.to,
    );
  }

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_AVAILABILITY_THROTTLE)
  @Post('select/slot')
  @HttpCode(HttpStatus.OK)
  async selectSlot(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SelectSlotDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res);
    await this.flow.selectSlot(principal.tenantId, conversationId, principal, dto.startAt);
    return { status: 'ok' };
  }

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_BOOKING_CONFIRM_THROTTLE)
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ConfirmBookingDto,
  ) {
    const { conversationId, principal } = await this.resolve(req, res);
    return this.flow.confirm(principal.tenantId, conversationId, principal, dto);
  }

  // ─────────────────────────────── Session ───────────────────────────────── //

  /**
   * Resolves (and, when needed, (re)writes) the two cookies every route
   * depends on: `guest_token` (identity, via `GuestSessionService` — the
   * same mechanism the chat widget uses) and `booking_session_id` (which
   * conversation row this booking's selections live on — nothing
   * server-side maps one to the other, so the client must carry it, exactly
   * like the AI chat widget already does for `aiConversationId`).
   */
  private async resolve(
    req: Request,
    res: Response,
    opts: { adoptConversationId?: string; fresh?: boolean } = {},
  ): Promise<{ conversationId: string; principal: GuestPrincipal }> {
    const existingGuestToken = readGuestTokenCookie(req);
    const guestSession = await this.guestSessions.resolveSession(existingGuestToken);
    if (guestSession.isNew) {
      res.cookie('guest_token', guestSession.token, {
        ...this.cookieOptions(),
        maxAge: guestSession.maxAgeMs,
      });
    }

    const cookieConversationId = req.cookies?.[BOOKING_SESSION_COOKIE] as
      | string
      | undefined;
    // Which conversation to resume: a fresh start ignores everything; otherwise the chat
    // widget's own conversation wins when (and only when) this guest owns it; otherwise the
    // cookie's. `ensureConversation` re-checks ownership of whatever it is handed.
    let existingConversationId: string | undefined = cookieConversationId;
    if (opts.fresh) {
      existingConversationId = undefined;
    } else if (opts.adoptConversationId) {
      const adopted = await this.bookingContext.adoptOwnedConversation(
        guestSession.tenantId,
        guestSession.guestId,
        opts.adoptConversationId,
      );
      if (adopted) existingConversationId = adopted;
    }
    const conversationId = await this.bookingContext.ensureConversation(
      guestSession.tenantId,
      guestSession.guestId,
      existingConversationId,
    );
    if (conversationId !== cookieConversationId) {
      res.cookie(BOOKING_SESSION_COOKIE, conversationId, {
        ...this.cookieOptions(),
        maxAge: guestSession.maxAgeMs,
      });
    }

    const principal: GuestPrincipal = {
      id: guestSession.guestId,
      tenantId: guestSession.tenantId,
      roles: [],
      permissions: [],
      guest: true,
    };
    return { conversationId, principal };
  }

  /**
   * Contract C10 — `booking_session_id` is the other anonymous patient cookie
   * `PUBLIC_COOKIE_SAMESITE`/`PUBLIC_COOKIE_DOMAIN` scope independently from the
   * staff session cookies. Each defaults to the existing global
   * `COOKIE_SAMESITE`/`COOKIE_DOMAIN` value, so no current deployment changes
   * behaviour until the public-specific vars are explicitly set.
   */
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: this.config.get<string>(
        'PUBLIC_COOKIE_SAMESITE',
        this.config.get<string>('COOKIE_SAMESITE', 'lax'),
      ) as CookieOptions['sameSite'],
      domain:
        this.config.get<string>('PUBLIC_COOKIE_DOMAIN') ||
        this.config.get<string>('COOKIE_DOMAIN') ||
        undefined,
      path: '/',
    };
  }
}
