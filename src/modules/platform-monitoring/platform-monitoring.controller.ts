import { Controller, Get, UseGuards } from '@nestjs/common';
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
}
