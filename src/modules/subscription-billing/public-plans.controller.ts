import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { PublicPlansService } from './public-plans.service';
import { PUBLIC_PLANS_THROTTLE } from './public-plans.throttle';

/**
 * Public pricing catalogue — ANONYMOUS (bypasses the global JwtAuthGuard via
 * `@Public`). Read-only; mutating plans stays on the super-admin-only
 * `/platform/billing/plans` routes, which this controller never touches.
 */
@ApiTags('Public Plans')
@Controller('public/plans')
export class PublicPlansController {
  constructor(private readonly plans: PublicPlansService) {}

  @Public()
  @ApiOperation({
    summary: 'List the plans currently offered for sale',
    description:
      'Active plans only, cheapest first, with price, billing cycle, configured limits and included features. ' +
      'Deactivating a plan removes it from this response immediately; existing subscribers are unaffected. ' +
      'Never cached (`Cache-Control: no-store`) so an admin change shows on the next request.',
  })
  @ApiOkResponse({ description: 'Currency + the active plan catalogue.' })
  @Throttle(PUBLIC_PLANS_THROTTLE)
  // `no-store`: a deactivated plan must not linger in a browser or CDN cache.
  @Header('Cache-Control', 'no-store')
  @Get()
  list() {
    return this.plans.getCatalog();
  }
}
