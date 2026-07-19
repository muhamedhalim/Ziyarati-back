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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';

import { AiTrainingFileService } from './ai-training-file.service';
import { UploadTrainingFileDto } from './dto/upload-training-file.dto';
import { UpdateTrainingFileDto } from './dto/update-training-file.dto';
import { TrainingFileFilterDto } from './dto/training-file-filter.dto';
import { UploadTrainingContentDto } from './dto/upload-training-content.dto';
import { AppError, ErrorCode } from '../../common/errors';
import { resolveMaxUploadBytes } from '../storage/storage.constants';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';

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
    status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'INDEXED', 'FAILED'], example: 'PENDING' },
    agent: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * AI training files (private upload + physical ingestion status). Guarded by
 * PermissionsGuard + ActiveTenantGuard; tenant id comes from TenantContext.
 */
@ApiTags('AI Training Files')
@ApiBearerAuth('JWT-auth')
@Controller('ai/training-files')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('ai')
export class AiTrainingFileController {
  constructor(
    private readonly files: AiTrainingFileService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Upload a UTF-8 TXT/Markdown training file to private storage' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: {
    file: { type: 'string', format: 'binary' }, agentId: { type: 'string', format: 'uuid' },
  } } })
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: resolveMaxUploadBytes() },
  }))
  @RequirePermissions(PERMISSION.AI_TRAINING_MANAGE)
  uploadContent(
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined,
    @Body() dto: UploadTrainingContentDto,
  ) {
    if (!file) throw new AppError(ErrorCode.BAD_REQUEST, { message: 'Training file is required' });
    return this.files.uploadContent(this.ctx.requireTenantId(), file, dto.agentId);
  }

  @ApiOperation({ summary: 'Register a training file', description: `**Protected — \`ai.training.manage\`. Clinic active.** Registers a tenant-owned private key in PENDING state.` })
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

  @ApiOperation({ summary: 'Update a training file', description: `**Protected — \`ai.training.manage\`. Clinic active.** Update display metadata; status is server-owned.` })
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

  @ApiOperation({ summary: 'Process a training file', description: `**Protected — \`ai.training.manage\`. Clinic active.** Fetches, extracts, chunks, embeds, and persists before setting INDEXED.` })
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
