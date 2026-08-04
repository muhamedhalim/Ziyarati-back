import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AiMemoryService } from './ai-memory.service';
import { RememberDto, RecallDto, MemoryFilterDto } from './dto/memory.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

/**
 * Long-term AI memory (Feature 5). Guarded by the AI guard chain (permissions +
 * active tenant + active subscription + `ai` feature). Semantic recall reuses the
 * shared embedding provider + pgvector; no logic is duplicated.
 */
@ApiTags('AI Memory')
@ApiBearerAuth('JWT-auth')
@Controller('ai/memory')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('ai')
export class AiMemoryController {
  constructor(
    private readonly memory: AiMemoryService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Store a long-term memory', description: 'Persists an important, reusable fact + its embedding (best-effort).' })
  @ApiCreatedResponse({ description: 'The stored memory.' })
  @Post()
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  remember(@Body() dto: RememberDto) {
    return this.memory.remember(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'Semantically recall memories', description: 'Ranked semantic recall (pgvector) with keyword fallback. Excludes expired memories.' })
  @ApiOkResponse({ description: 'Ranked recalled memories.' })
  @Post('recall')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_READ)
  recall(@Body() dto: RecallDto) {
    return this.memory.recall(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List memories', description: 'Paginated / filtered / searchable memory list for the viewer.' })
  @ApiOkResponse({ description: 'Paginated memories.' })
  @Get()
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_READ)
  list(@Query() filter: MemoryFilterDto) {
    return this.memory.list(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Summarize a conversation into memory', description: 'Derives + stores a heuristic conversation summary (no LLM call).' })
  @ApiParam({ name: 'aiConversationId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'The stored summary memory (or null when empty).' })
  @Post('summarize/:aiConversationId')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  summarize(@Param('aiConversationId', ParseUUIDPipe) aiConversationId: string) {
    // Authenticated tenant-scoped path: the conversation being summarised and the
    // memory being written both belong to the caller's own tenant.
    const tenantId = this.ctx.requireTenantId();
    return this.memory.summarizeConversation(tenantId, aiConversationId, undefined, tenantId);
  }

  @ApiOperation({ summary: 'Purge expired memories (tenant)', description: 'Physically deletes this tenant\'s expired memories.' })
  @ApiOkResponse({ description: '{ deleted } count.' })
  @Post('cleanup')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  cleanup() {
    return this.memory.cleanupExpired(this.ctx.requireTenantId());
  }

  @ApiOperation({ summary: 'Forget a memory', description: 'Deletes the memory + its embedding (FK cascade).' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Deleted id.' })
  @Delete(':id')
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  forget(@Param('id', ParseUUIDPipe) id: string) {
    return this.memory.forget(this.ctx.requireTenantId(), id);
  }
}
