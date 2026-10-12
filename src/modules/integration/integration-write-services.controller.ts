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
import { ApiIntegrationWriteErrors } from './integration-api-docs';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * External (M2M) service-catalog WRITE/upsert. Requires the
 * `integration.services.write` scope. Idempotent per (connection, external id).
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@ApiIntegrationWriteErrors()
@Controller('integrations/services')
export class IntegrationWriteServicesController {
  constructor(
    private readonly writes: IntegrationWriteService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Upsert a service',
    description:
      'Requires scope `integration.services.write`. Idempotent per (connection, externalId).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retry-safe write key (unique per clinic, 1-255 printable ASCII characters, honoured for 24 hours).',
  })
  @ApiKeyProtected(INTEGRATION_SCOPE.SERVICES_WRITE)
  @Post('upsert')
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Body() dto: UpsertRecordDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ip() ip: string,
  ) {
    const res = await this.writes.upsertViaApi(
      this.ctx.requireTenantId(),
      INTEGRATION_RESOURCE.SERVICE,
      dto.connectionId,
      dto.externalId,
      dto.data,
      idempotencyKey,
      { ip },
    );
    return res.body;
  }
}
