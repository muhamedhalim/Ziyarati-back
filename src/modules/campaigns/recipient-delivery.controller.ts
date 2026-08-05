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
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

/**
 * Delivery-receipt ingestion seam.
 *
 * Real channel providers (WhatsApp Cloud API, SMS DLRs, …) translate their
 * native callback into a {@link RecordDeliveryDto} and POST it here (or call
 * `RecipientDeliveryService.recordDelivery` directly from the provider adapter
 * — see `WhatsappWebhookService.applyDeliveryStatuses`, which resolves its own
 * tenantId from the webhook event row, never from client input).
 * Guarded by `campaigns.manage`; for a public provider webhook, front this with
 * the provider's signature verification instead of the RBAC guard.
 *
 * Tenant scoping (FND-004): the recipient lookup is scoped to the caller's
 * tenant IN THE QUERY — a foreign-tenant `provider_ref` (even if guessed/
 * observed) simply doesn't match, so this can never flip another tenant's
 * delivery status. Previously this relied solely on `provider_ref`
 * uniqueness, with no tenant check anywhere in the path.
 */
@ApiTags('Campaign Delivery')
@ApiBearerAuth('JWT-auth')
@Controller('campaigns/delivery')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class RecipientDeliveryController {
  constructor(
    private readonly delivery: RecipientDeliveryService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Record a delivery receipt (provider callback)' })
  @ApiOkResponse({ description: 'Receipt applied (or ignored if not a forward transition).' })
  @Post('receipts')
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  record(@Body() dto: RecordDeliveryDto) {
    return this.delivery.recordDelivery({
      providerRef: dto.providerRef,
      event: dto.event,
      tenantId: this.ctx.requireTenantId(),
    });
  }
}
