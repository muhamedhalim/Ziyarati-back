import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { WhatsappDlqService } from './whatsapp-dlq.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';

/**
 * WhatsApp DLQ admin endpoints — parked (poison) inbound webhook/media jobs.
 * Mirrors `CampaignDlqController`; guarded by the same permission as the
 * rest of the webhook admin surface (`whatsapp.webhooks.manage`).
 */
@ApiTags('WhatsApp DLQ (Admin)')
@ApiBearerAuth('JWT-auth')
@Controller('admin/whatsapp/dlq')
@UseGuards(PermissionsGuard)
export class WhatsappDlqController {
  constructor(private readonly dlq: WhatsappDlqService) {}

  @ApiOperation({ summary: 'DLQ depth' })
  @ApiOkResponse({ description: 'Current DLQ depth.' })
  @Get('depth')
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  async depth() {
    return { depth: await this.dlq.depth() };
  }

  @ApiOperation({ summary: 'List parked DLQ jobs' })
  @ApiOkResponse({ description: 'Parked dead-letter jobs.' })
  @Get()
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  list(@Query('limit') limit?: string) {
    return this.dlq.list(limit ? Number(limit) : 100);
  }

  @ApiOperation({ summary: 'Replay a DLQ job onto its source queue' })
  @ApiParam({ name: 'jobId', description: 'DLQ job id' })
  @ApiOkResponse({ description: 'Job replayed to its source queue.' })
  @Post(':jobId/replay')
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  replay(@Param('jobId') jobId: string) {
    return this.dlq.replay(jobId);
  }

  @ApiOperation({ summary: 'Discard a DLQ job' })
  @ApiParam({ name: 'jobId', description: 'DLQ job id' })
  @ApiOkResponse({ description: 'Job discarded.' })
  @Delete(':jobId')
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  discard(@Param('jobId') jobId: string) {
    return this.dlq.discard(jobId);
  }
}
