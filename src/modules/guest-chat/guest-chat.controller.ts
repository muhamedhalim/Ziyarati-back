import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Response } from 'express';

import { GuestSessionService } from './guest-session.service';
import { ConvertGuestDto } from './dto/convert-guest.dto';
import { Public } from '../auth/decorators/public.decorator';

/** Guest (anonymous) chat sessions — Feature 1. `@Public` (no auth required). */
@ApiTags('Guest Chat')
@Controller('public/guest')
export class GuestChatController {
  constructor(
    private readonly guest: GuestSessionService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @ApiOperation({
    summary: 'Start an anonymous guest AI session',
    description:
      'Mints a guest session token scoped to the system discovery tenant and sets it as the httpOnly `guest_token` cookie (path `/` so the AI WebSocket handshake receives it). The visitor can then chat with the AI without logging in. Returns the guest id.',
  })
  @ApiOkResponse({ description: '{ guestId } — the guest_token cookie is set.' })
  @Post('session')
  @HttpCode(HttpStatus.OK)
  async session(@Res({ passthrough: true }) res: Response) {
    const { token, guestId, maxAgeMs } = await this.guest.createSession();
    res.cookie('guest_token', token, { ...this.cookieOptions(), maxAge: maxAgeMs });
    return { guestId };
  }

  @Public()
  @ApiOperation({
    summary: 'Convert a guest conversation into a patient conversation',
    description:
      'When the visitor books / becomes a patient, carries the guest thread forward WITHOUT losing history by summarising it into the patient tenant\'s long-term memory (reuses AiMemoryService). Original guest messages remain intact.',
  })
  @ApiOkResponse({ description: '{ converted, memoryId }.' })
  @Post('convert')
  @HttpCode(HttpStatus.OK)
  convert(@Body() dto: ConvertGuestDto) {
    return this.guest.convert(dto.guestConversationId, dto.tenantId, dto.customerId);
  }

  /** httpOnly cookie at path `/` so the same-origin WS handshake receives it. */
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: (this.config.get<string>('COOKIE_SAMESITE', 'lax') as CookieOptions['sameSite']),
      domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
      path: '/',
    };
  }
}
