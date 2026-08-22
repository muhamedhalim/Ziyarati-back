import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';

import { GuestSessionService } from './guest-session.service';
import { ConvertGuestDto } from './dto/convert-guest.dto';
import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

/** Guest (anonymous) chat sessions — Feature 1. `@Public` (no auth required). */
@ApiTags('Guest Chat')
@Controller('public/guest')
export class GuestChatController {
  constructor(
    private readonly guest: GuestSessionService,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Public()
  // Session-genesis endpoint (see `@SkipCsrf`'s own docstring): it never reads
  // an incoming `access_token`/`refresh_token` cookie to authorize anything —
  // `GuestSessionService.createSession()` takes no request context at all, it
  // unconditionally mints a brand-new anonymous credential for the singleton
  // discovery tenant. A stale auth cookie left over from a previous/expired
  // session (root-scoped `access_token` is sent here by the browser purely
  // because of path overlap) is therefore not a real CSRF surface, exactly
  // like `login`/`register-owner`/`forgot-password`.
  //
  // Without this, a visitor whose session had gone stale (an expired/revoked
  // refresh token fails silently in `axiosInstance`'s response interceptor,
  // which clears the JS-readable `csrf_token` cookie but — being HttpOnly —
  // cannot touch the still-present `access_token` cookie) could never start a
  // guest chat again until that leftover cookie's own maxAge finally expired:
  // `CsrfGuard` saw the auth cookie, demanded a CSRF header the client no
  // longer had, and rejected every attempt with 403.
  @SkipCsrf()
  @ApiOperation({
    summary: 'Start an anonymous guest AI session',
    description:
      'Mints a guest session token scoped to the system discovery tenant and sets it as the httpOnly `guest_token` cookie (path `/` so the AI WebSocket handshake receives it). The visitor can then chat with the AI without logging in. Returns the guest id.',
  })
  @ApiOkResponse({
    description: '{ guestId } — the guest_token cookie is set.',
  })
  @Post('session')
  @HttpCode(HttpStatus.OK)
  async session(@Res({ passthrough: true }) res: Response) {
    const { token, guestId, maxAgeMs } = await this.guest.createSession();
    res.cookie('guest_token', token, {
      ...this.cookieOptions(),
      maxAge: maxAgeMs,
    });
    return { guestId };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Convert a guest conversation into a patient conversation',
    description:
      "When the visitor books / becomes a patient, carries the guest thread forward WITHOUT losing history by summarising it into the patient tenant's long-term memory (reuses AiMemoryService). Original guest messages remain intact.\n\n" +
      'AUTHENTICATED (FND-001). The target tenant comes from the authenticated principal — a `tenantId` in the body is rejected. The `guest_token` cookie must also be present: it proves which guest session owns the SOURCE conversation. Every ownership failure returns the same not-found response so nothing is disclosed.',
  })
  @ApiOkResponse({ description: '{ converted, memoryId }.' })
  @Post('convert')
  @HttpCode(HttpStatus.OK)
  convert(@Body() dto: ConvertGuestDto, @Req() req: Request) {
    // Target tenant: authenticated principal only, never the request body.
    const targetTenantId = this.tenantContext.requireTenantId();
    // Source binding: the browser's httpOnly guest cookie (path `/`, so it is
    // sent alongside `access_token` on this same-origin call).
    const guestToken = this.readGuestToken(req);
    return this.guest.convert(
      dto.guestConversationId,
      targetTenantId,
      guestToken,
      dto.customerId,
      this.tenantContext.getUser()?.id,
    );
  }

  /** Reads the httpOnly `guest_token` cookie (mirrors WsAuthService's approach). */
  private readGuestToken(req: Request): string | undefined {
    const fromParser = (req as unknown as { cookies?: Record<string, string> })
      .cookies?.guest_token;
    if (fromParser) return fromParser;
    const header = req.headers?.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === 'guest_token') return decodeURIComponent(rest.join('='));
    }
    return undefined;
  }

  /** httpOnly cookie at path `/` so the same-origin WS handshake receives it. */
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: this.config.get<string>(
        'COOKIE_SAMESITE',
        'lax',
      ) as CookieOptions['sameSite'],
      domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
      path: '/',
    };
  }
}
