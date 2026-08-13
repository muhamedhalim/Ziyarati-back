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
 * External (M2M) appointment WRITE/upsert. Requires the
 * `integration.appointments.write` scope.
 *
 * Every write is routed through the appointment LIFECYCLE service
 * (create / reschedule / cancel) by the shared pipeline — never a raw row write
 * — so tenant-scoped reference checks, the real availability re-check and
 * persistence all happen inside that service's own transaction. A double
 * booking or an invalid staff/service/branch combination therefore cannot be
 * produced through this endpoint.
 *
 * Read-only hints in `data` resolve dependencies from THIS connection's
 * mappings: `customerExternalId`, `staffExternalId`, `branchExternalId`,
 * `serviceExternalIds`. Lifecycle intent comes from `action`
 * (`reschedule` | `cancel`); anything else is treated as create-or-no-op.
 *
 * Status, ownership, payment, settlement, platform-fee, refund and provider
 * reference fields are PROTECTED and rejected with 422 — an external system may
 * describe when/who/what, never money or lifecycle state.
 *
 * The write is attributed to the tenant's integration SERVICE ACCOUNT (a real,
 * inactive, credential-less user), because `booked_by` is a genuine user FK and
 * an API-key principal is not a user.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('integrations/appointments')
export class IntegrationWriteAppointmentsController {
  constructor(
    private readonly writes: IntegrationWriteService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Upsert an appointment',
    description:
      'Requires scope `integration.appointments.write`. Idempotent per (connection, externalId). Routed through the appointment lifecycle service — availability is re-checked and financial/status fields are rejected.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retry-safe write key (unique per tenant).',
  })
  @ApiKeyProtected(INTEGRATION_SCOPE.APPOINTMENTS_WRITE)
  @Post('upsert')
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Body() dto: UpsertRecordDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ip() ip: string,
  ) {
    const res = await this.writes.upsertViaApi(
      this.ctx.requireTenantId(),
      INTEGRATION_RESOURCE.APPOINTMENT,
      dto.connectionId,
      dto.externalId,
      dto.data,
      idempotencyKey,
      { ip },
    );
    return res.body;
  }
}
