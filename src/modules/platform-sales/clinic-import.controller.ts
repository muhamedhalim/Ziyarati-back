import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import type { UploadedFileLike } from '../storage/uploads.controller';
import type { MulterLimitsWithNestingDepth } from '../storage/storage.constants';

import {
  CLINIC_IMPORT_MAX_BYTES,
  CLINIC_IMPORT_MAX_ROWS,
} from './clinic-import.constants';
import { ClinicImportService } from './clinic-import.service';
import { ClinicImportOptionsDto } from './dto/clinic-import.dto';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const UPLOAD_LIMITS: MulterLimitsWithNestingDepth = {
  fileSize: CLINIC_IMPORT_MAX_BYTES,
  fieldNestingDepth: 5,
  fields: 10,
  files: 1,
};

const FILE_BODY_SCHEMA = {
  type: 'object' as const,
  required: ['file'],
  properties: {
    file: { type: 'string' as const, format: 'binary' as const },
    sendInvitations: { type: 'string' as const, enum: ['true', 'false'] },
    assignmentKind: { type: 'string' as const, enum: ['acquired', 'managed'] },
  },
};

/**
 * Excel import of NEW clinics from the sales console. SUPER ADMIN ONLY, by
 * role — the same gate as every other `/platform/sales` route. The file is
 * parsed in memory and never stored; the actor comes from the token.
 */
@ApiTags('Platform Sales')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales/clinic-import')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class ClinicImportController {
  constructor(private readonly imports: ClinicImportService) {}

  @ApiOperation({
    summary: 'Download the clinic import template (super admin)',
  })
  @Get('template')
  async template(@Res() res: Response): Promise<void> {
    const buffer = await this.imports.buildTemplate();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="clinic-import-template.xlsx"',
    );
    res.send(buffer);
  }

  @ApiOperation({
    summary: 'Validate a clinic import file — writes nothing (super admin)',
    description: `Every row gets one status. Max ${CLINIC_IMPORT_MAX_ROWS} rows / ${CLINIC_IMPORT_MAX_BYTES / 1024 / 1024} MB, .xlsx only.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FILE_BODY_SCHEMA })
  @HttpCode(HttpStatus.OK)
  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS }))
  preview(@UploadedFile() file: UploadedFileLike | undefined) {
    return this.imports.preview(file);
  }

  @ApiOperation({
    summary: 'Create the clinics in a file (super admin)',
    description:
      'Re-parses and re-validates the file (a preview is never trusted), then creates each valid row in its own transaction (tenant + owner account [+ sales assignment]). Existing clinics are reported, never changed. Safe to repeat.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FILE_BODY_SCHEMA })
  @Post('commit')
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS }))
  commit(
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: ClinicImportOptionsDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.imports.commit(file, dto, actorUserId);
  }
}
