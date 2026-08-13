import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { EmailDeliveryService } from './email-delivery.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

class QueryEmailLogsDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number =
    20;
}

/**
 * Email delivery log + stats — super-admin observability for the email system.
 */
@ApiTags('Email Logs (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/email-logs')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class EmailLogController {
  constructor(private readonly delivery: EmailDeliveryService) {}

  @ApiOperation({ summary: 'List email delivery logs (super-admin)' })
  @ApiOkResponse({ description: 'Paginated, filterable email logs.' })
  @Get()
  list(@Query() query: QueryEmailLogsDto) {
    return this.delivery.listLogs(query);
  }

  @ApiOperation({ summary: 'Email delivery stats (super-admin)' })
  @ApiOkResponse({ description: 'Counts by status.' })
  @Get('stats')
  stats() {
    return this.delivery.stats();
  }
}
