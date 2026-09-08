import {
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { PlatformSpecialtiesService } from './platform-specialties.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

/**
 * Marketplace BE-1 (T056) — contract C9. Correction surface for the
 * `specialties` domain: add/remove/confirm clinic and doctor associations.
 *
 * SUPER ADMIN ONLY (RolesGuard), same pattern as `SystemSettingController`.
 * NOT a public route — never reachable from `PublicDiscoveryController`.
 * A console UI is explicitly out of scope; this is API-only.
 */
@ApiTags('Platform Specialties')
@ApiBearerAuth('JWT-auth')
@Controller('platform/specialties')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformSpecialtiesController {
  constructor(private readonly specialties: PlatformSpecialtiesService) {}

  @ApiOperation({
    summary: 'Assert (or confirm) a clinic ↔ specialty association',
    description:
      'Writes provenance ASSERTED. Idempotent: asserting an already-derived or already-asserted ' +
      'pair upgrades/keeps it ASSERTED — a human correction always wins over a later re-derivation.',
  })
  @ApiOkResponse({ description: 'Association asserted.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Post('tenants/:tenantId/:specialtyId')
  async assertTenantSpecialty(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('specialtyId', new ParseUUIDPipe()) specialtyId: string,
  ) {
    await this.specialties.assertTenantSpecialty(tenantId, specialtyId);
    return { asserted: true, tenantId, specialtyId };
  }

  @ApiOperation({ summary: 'Remove a clinic ↔ specialty association' })
  @ApiOkResponse({
    description: 'Association removed (no-op if it did not exist).',
  })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Delete('tenants/:tenantId/:specialtyId')
  async removeTenantSpecialty(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('specialtyId', new ParseUUIDPipe()) specialtyId: string,
  ) {
    await this.specialties.removeTenantSpecialty(tenantId, specialtyId);
    return { removed: true, tenantId, specialtyId };
  }

  @ApiOperation({
    summary: 'Assert (or confirm) a doctor ↔ specialty association',
    description:
      'Writes provenance ASSERTED, same semantics as the clinic-level endpoint.',
  })
  @ApiOkResponse({ description: 'Association asserted.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Post('doctors/:staffId/:specialtyId')
  async assertStaffSpecialty(
    @Param('staffId', new ParseUUIDPipe()) staffId: string,
    @Param('specialtyId', new ParseUUIDPipe()) specialtyId: string,
  ) {
    await this.specialties.assertStaffSpecialty(staffId, specialtyId);
    return { asserted: true, staffId, specialtyId };
  }

  @ApiOperation({ summary: 'Remove a doctor ↔ specialty association' })
  @ApiOkResponse({
    description: 'Association removed (no-op if it did not exist).',
  })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Delete('doctors/:staffId/:specialtyId')
  async removeStaffSpecialty(
    @Param('staffId', new ParseUUIDPipe()) staffId: string,
    @Param('specialtyId', new ParseUUIDPipe()) specialtyId: string,
  ) {
    await this.specialties.removeStaffSpecialty(staffId, specialtyId);
    return { removed: true, staffId, specialtyId };
  }
}
