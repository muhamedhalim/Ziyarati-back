import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ReconciliationExceptionService } from './reconciliation-exception.service';
import { ProviderReconciliationService } from './provider-reconciliation.service';
import {
  CloseReconciliationDto,
  ImportReconciliationReportDto,
  QueryReconciliationDto,
} from '../dto/reconciliation.dto';

import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLE } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';

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
 * PLATFORM-ONLY reconciliation queue (super admin).
 *
 * The daily provider reconciliation records discrepancies between what the gateway
 * says and what we recorded; an operator works them here. Nothing on this surface
 * moves money: closing an exception records a decision, and importing a report can
 * only apply fees and payout ids to charges we already hold.
 */
@ApiTags('Reconciliation (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/finance/reconciliation')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformReconciliationController {
  constructor(
    private readonly exceptions: ReconciliationExceptionService,
    private readonly reconciliation: ProviderReconciliationService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List reconciliation exceptions',
    description:
      '**Super admin.** Discrepancies found by the provider reconciliation, newest sighting first, with a count per state.',
  })
  @ApiOkResponse({ description: 'Paginated exceptions + counts by status.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @Get()
  list(@Query() query: QueryReconciliationDto) {
    return this.exceptions.list(query);
  }

  @ApiOperation({
    summary: 'Import a Tap charges report (CSV)',
    description:
      '**Super admin.** The fallback for a merchant whose report the API will not give us. Applies each captured charge’s fee and payout id ONCE to a payment we already hold, and records any discrepancy. Cannot create a payment, change a status or move money. The API’s JSON body cap (100 KB) applies: import one day or one merchant at a time.',
  })
  @ApiOkResponse({
    description: 'What the import matched, applied and flagged.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Empty, too large, or not a Tap charges report.',
    schema: S_ERROR,
  })
  @Post('import')
  @HttpCode(HttpStatus.OK)
  import(@Body() dto: ImportReconciliationReportDto) {
    return this.reconciliation.importChargesReport(
      dto.csv,
      this.ctx.getUser()?.id,
    );
  }

  @ApiOperation({
    summary: 'Get one reconciliation exception',
    description: '**Super admin.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.exceptions.detail(id);
  }

  @ApiOperation({
    summary: 'Resolve or ignore a reconciliation exception',
    description:
      '**Super admin.** Closes an OPEN exception. IGNORED requires a note. Recorded in the platform audit trail.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'The closed exception.' })
  @Patch(':id')
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseReconciliationDto,
  ) {
    return this.exceptions.close(
      id,
      this.ctx.getUser()?.id,
      dto.status,
      dto.note,
    );
  }
}
