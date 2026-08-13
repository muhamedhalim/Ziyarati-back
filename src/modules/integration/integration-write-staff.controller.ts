import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';

import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { INTEGRATION_SCOPE } from '../platform/integration-scopes.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { IntegrationWriteService } from '../integration-platform/write/integration-write.service';
import { INTEGRATION_RESOURCE } from '../integration-platform/integration-platform.constants';
import { UpsertRecordDto } from '../integration-platform/dto/upsert-record.dto';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * External (M2M) staff UPSERT — deliberately UPDATE/LINK ONLY.
 *
 * A staff profile is bound to one platform user account for life, so this
 * endpoint can NEVER create a staff member, a login, a role, or any access.
 * Only approved profile/booking fields (`title`, `bio`, `isAvailableForBooking`,
 * `bookingBufferMinutes`) may be set; account identity, roles, permissions,
 * access state, commissions, payouts and ratings are protected and rejected.
 *
 * Matching: by the mapping for (connection, externalId); failing that, by the
 * optional read-only `matchEmail` hint (exact, tenant-scoped, and refused when
 * ambiguous). An external staff record with no safe match raises a reviewable
 * CONFLICT (`staff_requires_account`) — invite the member through the platform's
 * existing invitation flow, then re-run to link them.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('integrations/staff')
export class IntegrationWriteStaffController {
  constructor(
    private readonly writes: IntegrationWriteService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Upsert a staff member (update/link only)',
    description:
      'Requires scope `integration.staff.write`. Never creates staff, accounts, roles or access. Send `matchEmail` to link an existing member.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retry-safe write key (unique per tenant).',
  })
  @ApiKeyProtected(INTEGRATION_SCOPE.STAFF_WRITE)
  @Post('upsert')
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Body() dto: UpsertRecordDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ip() ip: string,
  ) {
    const res = await this.writes.upsertViaApi(
      this.ctx.requireTenantId(),
      INTEGRATION_RESOURCE.STAFF,
      dto.connectionId,
      dto.externalId,
      dto.data,
      idempotencyKey,
      { ip },
    );
    return res.body;
  }
}
