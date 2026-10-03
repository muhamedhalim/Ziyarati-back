import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';

import { PublicPaymentService } from './public-payment.service';
import { ConfirmPublicReturnDto } from './dto/confirm-public-return.dto';
import {
  PUBLIC_PAY_CHECKOUT_THROTTLE,
  PUBLIC_PAY_RESOLVE_THROTTLE,
  PUBLIC_PAY_RETURN_THROTTLE,
} from './payments.constants';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

/**
 * Patient-facing payment surface. `@Public()` — a patient has no account; the
 * pay-link token is the credential (same posture as the appointment-action and
 * waitlist-offer links). No route accepts an amount, currency, tenant, merchant
 * or gateway: the server derives every one of them. A bad, unknown or foreign
 * token / charge id is always the same 404.
 */
@ApiTags('Public — Payments')
@Controller('public/payments')
export class PublicPaymentController {
  constructor(private readonly publicPayments: PublicPaymentService) {}

  @ApiOperation({
    summary: 'Describe a pay link (public)',
    description:
      '**Public — authorised by the link token.** What a payer needs to recognise the booking (clinic, services, time, amount) and whether it can be paid now: `payable | paid | expired | unavailable`. No patient identity. Unknown token → 404.',
  })
  @ApiParam({ name: 'token', description: 'Pay-link token', type: 'string' })
  @ApiOkResponse({ description: 'Pay-link view.' })
  @ApiNotFoundResponse({ description: 'Unknown token.', schema: S_ERROR })
  @Public()
  @Throttle(PUBLIC_PAY_RESOLVE_THROTTLE)
  @Get('links/:token')
  resolve(@Param('token') token: string) {
    return this.publicPayments.resolve(token);
  }

  @ApiOperation({
    summary: 'Start or resume the payment behind a pay link (public)',
    description:
      '**Public — authorised by the link token.** Accepts NO body: the price, clinic and merchant are derived server-side. Resumes a live attempt, or replaces a dead one, and returns `{ state: "redirect", redirectUrl }` (Tap’s hosted page) — or `paid | expired | unavailable | processing | failed`.',
  })
  @ApiParam({ name: 'token', description: 'Pay-link token', type: 'string' })
  @ApiOkResponse({ description: 'Checkout outcome.' })
  @ApiNotFoundResponse({ description: 'Unknown token.', schema: S_ERROR })
  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_PAY_CHECKOUT_THROTTLE)
  @Post('links/:token/checkout')
  @HttpCode(HttpStatus.OK)
  checkout(@Param('token') token: string) {
    return this.publicPayments.checkout(token);
  }

  @ApiOperation({
    summary: 'Report the outcome after the hosted payment page (public)',
    description:
      '**Public.** Takes the charge id from the return redirect, asks the gateway what happened and returns `paid | pending | failed`. UX only — the signed webhook remains the authority and settles the same payment idempotently. Unknown charge → 404.',
  })
  @ApiOkResponse({ description: 'Payment outcome.' })
  @ApiNotFoundResponse({ description: 'Unknown charge.', schema: S_ERROR })
  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_PAY_RETURN_THROTTLE)
  @Post('return')
  @HttpCode(HttpStatus.OK)
  confirmReturn(@Body() dto: ConfirmPublicReturnDto) {
    return this.publicPayments.confirmReturn(dto.chargeId);
  }
}
