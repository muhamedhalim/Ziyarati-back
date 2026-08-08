import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';

import { SupportJobsService } from './support-jobs.service';

/**
 * Delivery-infrastructure health for Platform Customer Service.
 *
 * NOT clinic-scoped, by design: queues and workers are a shared resource, so a
 * stalled email worker is the same incident for every clinic. That is safe to
 * expose here precisely because the response carries no tenant data at all —
 * only counts, states and timestamps.
 *
 * This controller has exactly ONE route, and it is a GET. There is deliberately
 * no pause, resume, drain, clean, delete, retry-all or job-payload endpoint
 * anywhere in this module: Support needs health information, not Redis
 * administration. The Redis connection string and Redis keys never appear in a
 * response either.
 */
@ApiTags('Platform Support — Jobs & Workers')
@ApiBearerAuth('JWT-auth')
@Controller('platform/support/jobs')
@UseGuards(PermissionsGuard)
export class PlatformSupportJobsController {
  constructor(private readonly jobs: SupportJobsService) {}

  @ApiOperation({
    summary: 'Queue and worker health',
    description:
      'Redis reachability, worker liveness (running / degraded / offline / unknown), and per-queue ' +
      'waiting/active/delayed/failed depth for the email, notifications and WhatsApp queues — plus ' +
      'the age of the oldest email still sitting QUEUED, the signal that distinguishes "the worker ' +
      'is down" from "nothing has been sent lately". No Redis keys, no connection string, no job ' +
      'payloads, no administration controls.',
  })
  @ApiOkResponse({ description: 'Infrastructure health snapshot.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_JOBS_READ)
  @Get('health')
  health() {
    return this.jobs.health();
  }
}
