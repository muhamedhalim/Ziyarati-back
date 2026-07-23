import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';

import {
  CONFLICT_POLICY,
  CONFLICT_RESOLUTION,
  ConflictResolution,
  IntegrationResource,
} from '../integration-platform.constants';
import { ResolveConflictDto } from '../dto/resolve-conflict.dto';
import { IntegrationConflictService } from './integration-conflict.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationUpsertService } from '../write/integration-upsert.service';

interface Actor {
  userId?: string;
  ip?: string;
}

/**
 * Manual conflict resolution (Phase 4). Resolution goes through the SHARED write
 * pipeline — never direct repository mutation — so `external_wins` re-applies the
 * external values with the exact same validation, protected-field rejection and
 * mapping logic as any other write. `platform_wins`/`ignored` need no data (the
 * platform record is kept) and are pure state transitions.
 *
 * Linear dependency direction (no cycle): this → {conflictService (repo-only),
 * upsertService, connectionService}; upsertService → conflictService.
 */
@Injectable()
export class IntegrationConflictResolutionService {
  constructor(
    private readonly conflicts: IntegrationConflictService,
    private readonly connections: IntegrationConnectionService,
    private readonly upsert: IntegrationUpsertService,
  ) {}

  async resolve(tenantId: string, conflictId: string, dto: ResolveConflictDto, actor: Actor) {
    const conflict = await this.conflicts.getOrThrow(tenantId, conflictId);
    const resolution = dto.resolution as ConflictResolution;

    if (resolution === CONFLICT_RESOLUTION.EXTERNAL_WINS) {
      if (!conflict.connection?.id) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Cannot apply external_wins: the connection was removed',
        });
      }
      if (!dto.data || typeof dto.data !== 'object') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message: 'external_wins resolution requires the external `data` to apply',
        });
      }
      // Re-apply through the ONE mutation path with the policy forced to
      // external_wins for this record only (protected fields still rejected).
      await this.connections.requireActive(tenantId, conflict.connection.id);
      await this.upsert.upsertOne(
        tenantId,
        conflict.resource_type as IntegrationResource,
        conflict.connection.id,
        CONFLICT_POLICY.EXTERNAL_WINS,
        conflict.external_id,
        dto.data,
        actor,
        { safe: false },
      );
    }
    // platform_wins / ignored: keep the platform record; nothing to write.

    return this.conflicts.markResolved(tenantId, conflictId, resolution, actor.userId);
  }
}
