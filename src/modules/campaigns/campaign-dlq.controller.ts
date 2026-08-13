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

import { CampaignDlqService } from './campaign-dlq.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * Campaign DLQ admin endpoints. Inspect parked (poison) recipient jobs and
 * replay or discard them. Guarded by the campaigns-manage permission.
 */
@ApiTags('Campaign DLQ (Admin)')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CAMPAIGNS)
@Controller('admin/campaigns/dlq')
@UseGuards(PermissionsGuard)
export class CampaignDlqController {
  constructor(private readonly dlq: CampaignDlqService) {}

  @ApiOperation({ summary: 'DLQ depth' })
  @ApiOkResponse({ description: 'Current DLQ depth.' })
  @Get('depth')
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  async depth() {
    return { depth: await this.dlq.depth() };
  }

  @ApiOperation({ summary: 'List parked DLQ jobs' })
  @ApiOkResponse({ description: 'Parked dead-letter jobs.' })
  @Get()
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  list(@Query('limit') limit?: string) {
    return this.dlq.list(limit ? Number(limit) : 100);
  }

  @ApiOperation({ summary: 'Replay a DLQ job' })
  @ApiParam({ name: 'jobId', description: 'DLQ job id' })
  @ApiOkResponse({ description: 'Job replayed to its source queue.' })
  @Post(':jobId/replay')
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  replay(@Param('jobId') jobId: string) {
    return this.dlq.replay(jobId);
  }

  @ApiOperation({ summary: 'Discard a DLQ job' })
  @ApiParam({ name: 'jobId', description: 'DLQ job id' })
  @ApiOkResponse({ description: 'Job discarded.' })
  @Delete(':jobId')
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  discard(@Param('jobId') jobId: string) {
    return this.dlq.discard(jobId);
  }
}
