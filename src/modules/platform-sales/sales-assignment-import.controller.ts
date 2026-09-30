import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  ImportAssignmentsDto,
  QueryAssignmentsExportDto,
} from './dto/sales-import-dtos';
import { SALES_IMPORT_MAX_BYTES } from './platform-sales.constants';
import { SalesAssignmentImportService } from './sales-assignment-import.service';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const UPLOAD_LIMITS: MulterLimitsWithNestingDepth = {
  fileSize: SALES_IMPORT_MAX_BYTES,
  fieldNestingDepth: 5,
  fields: 10,
};

const FILE_BODY_SCHEMA = {
  type: 'object' as const,
  required: ['file'],
  properties: {
    file: { type: 'string' as const, format: 'binary' as const },
    onConflict: { type: 'string' as const, enum: ['skip', 'reassign'] },
    defaultKind: { type: 'string' as const, enum: ['acquired', 'managed'] },
  },
};

/**
 * Excel import / export of clinic assignments. SUPER ADMIN ONLY, by role.
 *
 * The employee is always the one in the path (re-verified as a live, ACTIVE
 * `platform_sales` user) — the file cannot name one. The file is parsed in
 * memory and never stored. Static `assignments/…` paths do not collide with
 * `SalesAssignmentsController`'s routes (there is no `assignments/:id`).
 */
@ApiTags('Platform Sales')
@ApiBearerAuth('JWT-auth')
@Controller('platform/sales')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class SalesAssignmentImportController {
  constructor(private readonly imports: SalesAssignmentImportService) {}

  @ApiOperation({ summary: 'Download the assignment import template (super admin)' })
  @Get('assignments/import/template')
  async template(@Res() res: Response): Promise<void> {
    const buffer = await this.imports.buildTemplate();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="sales-assignment-import-template.xlsx"',
    );
    res.send(buffer);
  }

  @ApiOperation({
    summary: 'Validate an assignment import file — writes nothing (super admin)',
    description:
      'Every row gets one status. Max 2,000 rows / 5 MB. The employee comes from the path.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FILE_BODY_SCHEMA })
  @HttpCode(HttpStatus.OK)
  @Post('employees/:id/assignments/import/preview')
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS }))
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: ImportAssignmentsDto,
  ) {
    return this.imports.preview(id, file, dto);
  }

  @ApiOperation({
    summary: 'Import assignments from a file (super admin)',
    description:
      'Re-parses and re-validates the file (a preview is never trusted), then applies every valid row in one transaction. Other rows are reported, not applied. Safe to repeat: rows already assigned are no-ops.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FILE_BODY_SCHEMA })
  @Post('employees/:id/assignments/import/commit')
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS }))
  commit(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: ImportAssignmentsDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.imports.commit(id, file, dto, actorUserId);
  }

  @ApiOperation({
    summary: 'Export clinic assignments as .xlsx (super admin)',
    description:
      'Streams a page at a time. Cells are formula-escaped. `employeeId` narrows to one employee; `status` is active (default), ended or all.',
  })
  @Get('assignments/export')
  async export(
    @Query() query: QueryAssignmentsExportDto,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer } = await this.imports.exportAssignments(query);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="sales-assignments-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(buffer);
  }
}
