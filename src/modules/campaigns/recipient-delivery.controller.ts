import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { RecipientDeliveryService } from './recipient-delivery.service';
import { RecordDeliveryDto } from './dto/record-delivery.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';

/**
 * Delivery-receipt ingestion seam.
 *
 * Real channel providers (WhatsApp Cloud API, SMS DLRs, …) translate their
 * native callback into a {@link RecordDeliveryDto} and POST it here (or call
 * `RecipientDeliveryService.recordDelivery` directly from the provider adapter).
 * Guarded by `campaigns.manage`; for a public provider webhook, front this with
 * the provider's signature verification instead of the RBAC guard.
 */
@ApiTags('Campaign Delivery')
@ApiBearerAuth('JWT-auth')
@Controller('campaigns/delivery')
@UseGuards(PermissionsGuard)
export class RecipientDeliveryController {
  constructor(private readonly delivery: RecipientDeliveryService) {}

  @ApiOperation({ summary: 'Record a delivery receipt (provider callback)' })
  @ApiOkResponse({ description: 'Receipt applied (or ignored if not a forward transition).' })
  @Post('receipts')
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  record(@Body() dto: RecordDeliveryDto) {
    return this.delivery.recordDelivery({ providerRef: dto.providerRef, event: dto.event });
  }
}
