import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { PaymentGatewayService } from './payment-gateway.service';
import {
  CreatePaymentGatewayDto,
  UpdatePaymentGatewayDto,
} from './dto/upsert-payment-gateway.dto';

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
 * PLATFORM-ONLY payment gateway configuration.
 *
 * CRITICAL business rule: the payment gateway is owned by the PLATFORM, not by
 * tenants. This controller is restricted to SUPER ADMIN via RolesGuard — tenants
 * can never reach it. There is no tenant scoping here by design; gateways are
 * platform infrastructure. Live secrets stay in env/ConfigService, never here.
 */
@ApiTags('Payment Gateways (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('payment-gateways')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PaymentGatewayController {
  constructor(private readonly gateways: PaymentGatewayService) {}

  @ApiOperation({
    summary: 'List payment gateways (super admin)',
    description:
      '**Platform-only — SUPER ADMIN.** Lists configured gateways (platform infrastructure).',
  })
  @ApiOkResponse({ description: 'Configured gateways.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @Get()
  list() {
    return this.gateways.list();
  }

  @ApiOperation({
    summary: 'Register a payment gateway (super admin)',
    description:
      '**Platform-only — SUPER ADMIN.** Registers a gateway configuration. NEVER include live secrets — those live in env/ConfigService.',
  })
  @ApiCreatedResponse({ description: 'Gateway registered.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @Post()
  create(@Body() dto: CreatePaymentGatewayDto) {
    return this.gateways.create(dto);
  }

  @ApiOperation({
    summary: 'Get a payment gateway (super admin)',
    description: '**Platform-only — SUPER ADMIN.**',
  })
  @ApiParam({
    name: 'id',
    description: 'Gateway UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Gateway details.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Gateway not found.', schema: S_ERROR })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.gateways.get(id);
  }

  @ApiOperation({
    summary: 'Update a payment gateway (super admin)',
    description:
      '**Platform-only — SUPER ADMIN.** Update name / active flag / non-secret config.',
  })
  @ApiParam({
    name: 'id',
    description: 'Gateway UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Gateway updated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a super admin.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Gateway not found.', schema: S_ERROR })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentGatewayDto,
  ) {
    return this.gateways.update(id, dto);
  }
}
