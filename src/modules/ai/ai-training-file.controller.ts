import {
  Body,
  Controller,
  Delete,
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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AiTrainingFileService } from './ai-training-file.service';
import { UploadTrainingFileDto } from './dto/upload-training-file.dto';
import { UpdateTrainingFileDto } from './dto/update-training-file.dto';
import { TrainingFileFilterDto } from './dto/training-file-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

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

const S_FILE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    file_name: { type: 'string', example: 'clinic-faq.pdf' },
    file_url: { type: 'string' },
    file_type: { type: 'string', nullable: true, example: 'PDF' },
    status: { type: 'string', enum: ['UPLOADED', 'PROCESSING', 'INDEXED', 'FAILED'], example: 'UPLOADED' },
    agent: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * AI training files (metadata + ingestion status). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext. No storage implementation —
 * processing is an abstraction seam.
 */
@ApiTags('AI Training Files')
@ApiBearerAuth('JWT-auth')
@Controller('ai/training-files')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class AiTrainingFileController {
  constructor(
    private readonly files: AiTrainingFileService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Register a training file', description: `**Protected — \`ai.training.manage\`. Clinic active.** Stores file metadata (status UPLOADED). Agent validated tenant-scoped.` })
  @ApiCreatedResponse({ description: 'Training file registered.', schema: S_FILE })
  @ApiBadRequestResponse({ description: 'Validation failed (unsupported file type).', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.training.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Agent not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.AI_TRAINING_MANAGE)
  upload(@Body() dto: UploadTrainingFileDto) {
    return this.files.upload(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List training files', description: `**Protected — \`ai.training.read\`. Clinic active.** Filter by agent/status.` })
  @ApiOkResponse({ description: 'Paginated training files.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.training.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.AI_TRAINING_READ)
  findAll(@Query() filter: TrainingFileFilterDto) {
    return this.files.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Get a training file', description: `**Protected — \`ai.training.read\`. Clinic active.**` })
  @ApiParam({ name: 'id', description: 'File UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Training file.', schema: S_FILE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.training.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'File not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.AI_TRAINING_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update a training file', description: `**Protected — \`ai.training.manage\`. Clinic active.** Update name/status.` })
  @ApiParam({ name: 'id', description: 'File UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'File updated.', schema: S_FILE })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.training.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'File not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.AI_TRAINING_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTrainingFileDto) {
    return this.files.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Process a training file', description: `**Protected — \`ai.training.manage\`. Clinic active.** Ingestion seam — transitions the file to INDEXED. A real pipeline would extract text → knowledge chunks.` })
  @ApiParam({ name: 'id', description: 'File UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'File processed (INDEXED).', schema: S_FILE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.training.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'File not found.', schema: S_ERROR })
  @Post(':id/process')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_TRAINING_MANAGE)
  process(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.process(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Reprocess a failed file', description: `**Protected — \`ai.training.manage\`. Clinic active.** Re-ingests a FAILED file (422 if not FAILED).` })
  @ApiParam({ name: 'id', description: 'File UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'File reprocessed.', schema: S_FILE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.training.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'File not found.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'File is not in FAILED status.', schema: S_ERROR })
  @Post(':id/reprocess')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_TRAINING_MANAGE)
  reprocess(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.reprocess(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Delete a training file', description: `**Protected — \`ai.training.manage\`. Clinic active.**` })
  @ApiParam({ name: 'id', description: 'File UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'File deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.training.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'File not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.AI_TRAINING_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.remove(this.ctx.requireTenantId(), id);
  }
}
