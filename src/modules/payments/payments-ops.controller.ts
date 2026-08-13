import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { FinancialMetricsService } from './financial-metrics.service';
import { RefundRecoveryService } from './refund-recovery.service';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * PLATFORM-ONLY payments operations (super admin).
 *  - GET  metrics       → financial observability gauges + reaper heartbeat (H4).
 *  - POST refunds/reap  → manual refund-recovery trigger so an operator can run
 *                         recovery without the worker/cron (M5 safeguard); the
 *                         reaper is idempotent so this is always safe to call.
 */
@ApiTags('Payments Ops (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/payments')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PaymentsOpsController {
  constructor(
    private readonly metrics: FinancialMetricsService,
    private readonly recovery: RefundRecoveryService,
  ) {}

  @ApiOperation({
    summary: 'Financial metrics (super admin)',
    description:
      '**Platform-only.** Live gauges for alerting: pending-refund count/max-age, open-clawback count/max-age, negative-settlement count, and the reaper heartbeat (worker liveness).',
  })
  @ApiOkResponse({ description: 'Financial metrics snapshot.' })
  @Get('metrics')
  metricsSnapshot() {
    return this.metrics.collect();
  }

  @ApiOperation({
    summary: 'Run refund recovery now (super admin)',
    description:
      '**Platform-only.** Synchronously runs the stale-PENDING refund reaper in-process — an operational fallback when the background worker is unavailable. Idempotent.',
  })
  @ApiOkResponse({ description: 'Reaper run summary.' })
  @Post('refunds/reap')
  @HttpCode(HttpStatus.OK)
  reapNow() {
    return this.recovery.reapStalePending();
  }
}
