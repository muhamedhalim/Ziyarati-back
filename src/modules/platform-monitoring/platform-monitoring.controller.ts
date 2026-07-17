import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { MonitoringService } from './monitoring.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Platform monitoring dashboard — super-admin only. Read-only snapshot of system
 * health, traffic, infrastructure, queues, webhooks and derived alerts. Composes
 * existing infra primitives (QueueService, health checks, logs) — no duplicates.
 */
@ApiTags('Platform Monitoring')
@ApiBearerAuth('JWT-auth')
@Controller('platform/monitoring')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformMonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @ApiOperation({
    summary: 'Full monitoring snapshot (super-admin)',
    description:
      'System health (API/DB/Redis/BullMQ/workers), traffic (requests, latency, error rate, slow endpoints), infrastructure (memory/CPU/uptime/storage), external-service configuration, per-queue depths, webhook success/failure, and derived critical/warning/healthy alerts.',
  })
  @ApiOkResponse({ description: 'Monitoring snapshot.' })
  @Get('overview')
  overview() {
    return this.monitoring.overview();
  }

  @ApiOperation({
    summary: 'WhatsApp / Meta App readiness (super-admin)',
    description:
      'Per-value configured/missing status for the platform Meta App (App ID, Embedded Signup Config ID, App Secret, Webhook Verify Token, Graph API version), whether the Embedded Signup flow and webhook ingestion are actually ready, Redis reachability, worker liveness, and the webhook callback URL as reachable from this request. Never returns secret values — configured/missing only.',
  })
  @ApiOkResponse({ description: 'WhatsApp readiness snapshot.' })
  @Get('whatsapp-readiness')
  whatsappReadiness(@Req() req: Request) {
    const origin = `${req.protocol}://${req.get('host')}`;
    return this.monitoring.whatsappReadiness(origin);
  }
}
