import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { AppError, ErrorCode } from '../../common/errors';
import { ContactLeadService } from './contact-lead.service';

/** Super-admin view of the public Contact Us enquiries (CR-05). */
@ApiTags('Platform Contact Leads')
@ApiBearerAuth('JWT-auth')
@Controller('platform/contact-leads')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformContactLeadsController {
  constructor(private readonly leads: ContactLeadService) {}

  @Get()
  @ApiOperation({ summary: 'List website enquiries, newest first (super-admin)' })
  list(
    @Query('status') status?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit = 25,
  ) {
    if (status !== undefined && status !== 'new' && status !== 'handled') {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: 'status must be "new" or "handled"' });
    }
    return this.leads.list({
      status: status as 'new' | 'handled' | undefined,
      page: Math.max(1, page),
      limit: Math.min(100, Math.max(1, limit)),
    });
  }

  @Post(':id/handled')
  @ApiOperation({ summary: 'Mark an enquiry as handled (super-admin)' })
  async markHandled(@Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.leads.markHandled(id))) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Enquiry not found' });
    }
    return { handled: true };
  }
}
