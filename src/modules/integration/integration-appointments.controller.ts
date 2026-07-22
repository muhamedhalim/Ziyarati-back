import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { AppointmentsService } from '../appointment/appointment.service';
import { QueryAppointmentsDto } from '../appointment/dto/query-appointments.dto';
import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { INTEGRATION_SCOPE } from '../platform/integration-scopes.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { toIntegrationAppointment } from './integration.mappers';

/**
 * Read-only external view of appointments. Delegates to the existing
 * tenant-scoped AppointmentsService. Excludes clinical/free-text `notes`,
 * payment fields (`total_amount`, `currency`, `payment_status`), and internal
 * bookkeeping (`booked_by`, `version`) — schedule facts only.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@Controller('integrations/appointments')
export class IntegrationAppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List appointments',
    description:
      'Requires scope `integration.appointments.read`. Paginated (max 100/page); filter by status/branch/staff/customer/date range.',
  })
  @ApiOkResponse({ description: 'Paginated appointments.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.APPOINTMENTS_READ)
  @Get()
  async list(@Query() query: QueryAppointmentsDto) {
    const result = await this.appointments.findAll(this.ctx.requireTenantId(), query);
    return { ...result, data: result.data.map(toIntegrationAppointment) };
  }

  @ApiOperation({
    summary: 'Get an appointment',
    description: 'Requires scope `integration.appointments.read`. An appointment from another tenant returns 404.',
  })
  @ApiOkResponse({ description: 'Appointment detail.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.APPOINTMENTS_READ)
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toIntegrationAppointment(await this.appointments.findOne(this.ctx.requireTenantId(), id));
  }
}
