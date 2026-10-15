import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';

import {
  CONFLICT_POLICY,
  CONFLICT_RESOLUTION,
  CONFLICT_STATUS,
  ConflictResolution,
  IntegrationResource,
} from '../integration-platform.constants';
import { ResolveConflictDto } from '../dto/resolve-conflict.dto';
import { IntegrationConflictService } from './integration-conflict.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationUpsertService } from '../write/integration-upsert.service';
import { IntegrationServiceAccountService } from '../write/integration-service-account.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';

interface Actor {
  userId?: string;
  ip?: string;
}

/** The subset of a conflict this service needs for its staleness check. */
interface StaleCheckable {
  id: string;
  resource_type: string;
  internal_resource_id?: string | null;
  conflicting_fields: string[];
  platform_hash?: string | null;
}

/**
 * Manual conflict resolution (Phase 4) — concurrency-safe.
 *
 * Resolution goes through the SHARED write pipeline, never direct repository
 * mutation, so `external_wins` re-applies external values with the exact same
 * validation, protected-field rejection and mapping logic as any other write.
 *
 * ORDER OF OPERATIONS, and why:
 *
 *  1. CLAIM the conflict (pending|stale → resolving) with a CONDITIONAL UPDATE.
 *     This is the mutual-exclusion primitive: exactly one of two concurrent
 *     resolvers can win it, so two admins can never apply competing outcomes.
 *     A read-then-check would not do — both readers would see `pending`.
 *  2. Verify TENANT + CONNECTION ownership (the conflict is loaded tenant-scoped;
 *     the connection must still be active to write through).
 *  3. Verify the internal record still EXISTS and has NOT CHANGED, by comparing a
 *     safe canonical hash of its current allowlisted values against the hash
 *     stored when the conflict was raised. If it moved on, the stored external
 *     snapshot is NOT applied: the conflict is refreshed to `stale` and the
 *     caller gets a 409 telling them to re-review.
 *  4. Apply, then mark resolved — and the mark only succeeds from `resolving`,
 *     so a late duplicate submit cannot overwrite the recorded outcome.
 *
 * If the apply fails, the claim is RELEASED back to `pending` so a conflict is
 * never left stuck in `resolving`.
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
    private readonly serviceAccount: IntegrationServiceAccountService,
    private readonly audit: IntegrationAuditService,
  ) {}

  async resolve(tenantId: string, conflictId: string, dto: ResolveConflictDto, actor: Actor) {
    const conflict = await this.conflicts.getOrThrow(tenantId, conflictId);
    const resolution = dto.resolution as ConflictResolution;
    const previousStatus = conflict.status;

    // Already finished — never silently "re-resolve" it.
    if (previousStatus === CONFLICT_STATUS.RESOLVED || previousStatus === CONFLICT_STATUS.IGNORED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This conflict has already been resolved',
      });
    }

    // 1. ATOMIC CLAIM — the double-resolution guard.
    const claimed = await this.conflicts.claim(tenantId, conflictId);
    if (!claimed) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This conflict is already being resolved by someone else',
      });
    }

    try {
      if (resolution === CONFLICT_RESOLUTION.EXTERNAL_WINS) {
        // 2. Ownership: the connection must still exist and be active.
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
        await this.connections.requireActive(tenantId, conflict.connection.id);

        // 3. STALENESS: has the internal record moved on since the conflict?
        await this.assertNotStale(tenantId, conflict, actor, previousStatus);

        // 4. Apply through the ONE mutation path, policy forced to external_wins
        //    for this record only. Protected fields are still rejected.
        await this.upsert.upsertOne(
          tenantId,
          conflict.resource_type as IntegrationResource,
          conflict.connection.id,
          CONFLICT_POLICY.EXTERNAL_WINS,
          conflict.external_id,
          dto.data,
          { ...actor, userId: await this.serviceAccount.resolveActorUserId(tenantId, actor.userId) },
          { safe: false },
        );
      }
      // platform_wins / ignored: keep the platform record; nothing to write.

      const resolved = await this.conflicts.markResolved(tenantId, conflictId, resolution, actor.userId);

      await this.audit.record(
        INTEGRATION_AUDIT_ACTION.CONFLICT_RESOLVE,
        tenantId,
        'IntegrationConflict',
        conflictId,
        actor,
        {
          previousStatus,
          resolution,
          policy: conflict.policy,
          reason: conflict.reason,
          resourceType: conflict.resource_type,
          externalId: conflict.external_id,
          connectionId: conflict.connection?.id ?? null,
          result: resolved.status,
        },
      );
      return resolved;
    } catch (err) {
      // Never leave a conflict stuck in `resolving`. `markStale` has already
      // moved it to `stale`, so this only releases a still-claimed row.
      await this.conflicts.release(tenantId, conflictId);
      throw err;
    }
  }

  /**
   * Compare the record's CURRENT allowlisted values against the platform hash
   * recorded when the conflict was raised. A mismatch means someone changed the
   * record in the meantime, so applying the stored external snapshot would
   * silently overwrite that newer change.
   */
  private async assertNotStale(
    tenantId: string,
    conflict: StaleCheckable,
    actor: Actor,
    previousStatus: string,
  ): Promise<void> {
    const internalId = conflict.internal_resource_id;
    // No internal record yet (e.g. `staff_requires_account`) — nothing to be
    // stale against; the upsert itself re-derives the current state.
    if (!internalId) return;

    const current = await this.upsert.currentViewOf(
      tenantId,
      conflict.resource_type as IntegrationResource,
      internalId,
    );

    if (!current) {
      await this.conflicts.markStale(tenantId, conflict.id, null);
      await this.auditStale(tenantId, conflict.id, actor, previousStatus, 'record_deleted');
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'The internal record no longer exists — this conflict is stale and cannot be applied',
      });
    }

    const currentHash = IntegrationConflictService.hashValues(conflict.conflicting_fields, current);
    if (conflict.platform_hash && currentHash !== conflict.platform_hash) {
      // Refresh, don't discard: the conflict becomes `stale` carrying the CURRENT
      // platform hash, so a reviewer sees an up-to-date comparison.
      await this.conflicts.markStale(tenantId, conflict.id, currentHash);
      await this.auditStale(tenantId, conflict.id, actor, previousStatus, 'record_changed');
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'The platform record changed after this conflict was raised — review the refreshed comparison before applying external data',
      });
    }
  }

  private auditStale(
    tenantId: string,
    conflictId: string,
    actor: Actor,
    previousStatus: string,
    cause: string,
  ): Promise<void> {
    return this.audit.record(
      INTEGRATION_AUDIT_ACTION.CONFLICT_STALE,
      tenantId,
      'IntegrationConflict',
      conflictId,
      actor,
      { previousStatus, cause, result: CONFLICT_STATUS.STALE, rejected: true },
    );
  }
}
