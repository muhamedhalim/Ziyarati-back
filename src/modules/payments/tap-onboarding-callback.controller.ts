import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';

import { TapOnboardingService } from './tap-onboarding.service';
import { TAP_ONBOARDING_CALLBACK_THROTTLE } from './payments.constants';

/**
 * Where Tap posts clinic-onboarding (Connect) events.
 *
 * `@Public()` — there is no user. Tap documents NO signature for these events,
 * so the unguessable per-session token in the URL is the only authenticator, and
 * even a correct token only lets the body be recorded as an advisory CLAIM (see
 * `TapOnboardingService.recordCallback`): nothing posted here can approve a
 * clinic or choose where its money goes.
 *
 * The answer is the same 200 for a valid, stale, malformed or unknown token, so
 * the route cannot be used to probe which tokens exist, and Tap is never told to
 * retry because of a superseded session. The body is typed as a plain record so
 * the global ValidationPipe never whitelist-strips (or echoes) a provider object
 * that may carry credentials; it is never logged.
 */
@ApiTags('Payments Webhooks')
@Controller('payments/webhooks/tap/onboarding')
export class TapOnboardingCallbackController {
  private readonly logger = new Logger('TapOnboardingCallback');

  constructor(private readonly onboarding: TapOnboardingService) {}

  @ApiOperation({
    summary: 'Receive a Tap clinic-onboarding event (public)',
    description:
      '**Public endpoint — called by Tap, not by app users.** Authenticated only by the unguessable token in the URL. Records an allow-listed, advisory claim for platform-admin review; never approves a clinic. Always answers 200.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { received: { type: 'boolean', example: true } },
    },
  })
  @Public()
  @SkipCsrf()
  @Throttle(TAP_ONBOARDING_CALLBACK_THROTTLE)
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('token') token: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      await this.onboarding.recordCallback(token, body);
    } catch (err) {
      // Not rethrown on purpose: a persistence hiccup must not surface as a 5xx
      // (which would also log the request body, a possible credential carrier).
      // The clinic simply stays in its current status for the admin to review.
      // Only the error text is logged — never the body.
      this.logger.error(
        `Tap onboarding callback not recorded: ${(err as Error)?.message}`,
      );
    }
    return { received: true };
  }
}
