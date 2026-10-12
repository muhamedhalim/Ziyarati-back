import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';

import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  ADMISSION_OP,
  IntegrationResource,
  CONFLICT_REASON,
  MAX_UPSERT_PAYLOAD_BYTES,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import {
  IntegrationIdempotencyService,
  assertValidIdempotencyKey,
} from '../idempotency/integration-idempotency.service';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationServiceAccountService } from './integration-service-account.service';
import { IntegrationUpsertService, UpsertActor } from './integration-upsert.service';

function conflictMessage(reason: string | undefined): string {
  switch (reason) {
    case CONFLICT_REASON.STAFF_REQUIRES_ACCOUNT:
      return 'No matching staff member exists and an integration cannot create one — the record was queued for the clinic to review';
    case CONFLICT_REASON.LIFECYCLE_NOT_ALLOWED:
      return 'The requested lifecycle change is not allowed for this record — it was not applied';
    case CONFLICT_REASON.MISSING_DEPENDENCY:
      return 'A referenced record could not be resolved — nothing was applied and the record was queued for the clinic to review';
    default:
      return 'The platform record has changed since this integration last wrote it — the update was not applied and was queued for the clinic to review';
  }
}

export interface ApiUpsertResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Orchestrates one M2M write/upsert request end-to-end (Phase 3):
 * resolve ACTIVE connection → idempotency begin (replay/racing/mismatch) →
 * single-record upsert → idempotency complete. Keeps the per-resource M2M
 * controllers thin and guarantees they all share the exact same write path.
 */
@Injectable()
export class IntegrationWriteService {
  constructor(
    private readonly connections: IntegrationConnectionService,
    private readonly idempotency: IntegrationIdempotencyService,
    private readonly upsert: IntegrationUpsertService,
    private readonly admission: IntegrationAdmissionService,
    private readonly serviceAccount: IntegrationServiceAccountService,
    private readonly ctx: TenantContextService,
  ) {}

  /** `apikey:<id>` principal → the raw key id, for per-key admission. */
  private currentKeyId(): string | null {
    const id = this.ctx.getUser()?.id;
    return id?.startsWith('apikey:') ? id.slice('apikey:'.length) : null;
  }

  async upsertViaApi(
    tenantId: string,
    resource: IntegrationResource,
    connectionId: string,
    externalId: string,
    data: Record<string, unknown>,
    idempotencyKey: string | undefined,
    actor: UpsertActor,
  ): Promise<ApiUpsertResponse> {
    // A malformed key is refused before any work (it used to reach the
    // varchar(255) column and surface as a 500).
    assertValidIdempotencyKey(idempotencyKey);

    // Admission BEFORE any persistence/enqueue: an oversized or over-budget
    // request is rejected without side effects. Write admission FAILS CLOSED if
    // the limiter is unreachable — it never inherits the read API's fail-open.
    this.admission.assertPayloadSize(data, MAX_UPSERT_PAYLOAD_BYTES, 'upsert payload');
    await this.admission.admit(ADMISSION_OP.WRITE, {
      tenantId,
      keyId: this.currentKeyId(),
      connectionId,
    });

    const connection = await this.connections.requireActive(tenantId, connectionId);
    const policy = this.connections.conflictPolicyOf(connection);

    // Bind the METHOD + ROUTE (`endpoint`) into the hash so the same key reused
    // on a different route/method with a different body is a clean mismatch (422)
    // rather than an accidental replay of an unrelated stored response.
    const endpoint = `POST ${resource}.upsert`;
    const requestHash = this.idempotency.hashPayload({ endpoint, resource, connectionId, externalId, data });
    const begin = await this.idempotency.begin(tenantId, connectionId, idempotencyKey, endpoint, requestHash);
    if (begin.replay) {
      return { status: begin.replay.status, body: begin.replay.body };
    }

    // An M2M call has no signed-in user, but appointments record real ownership
    // (`booked_by` is a user FK). Attribute the write to the tenant's verified
    // integration SERVICE ACCOUNT — never to a fabricated id and never to the
    // `apikey:<id>` principal, which is not a user.
    const attributedActor: UpsertActor = {
      ...actor,
      userId: await this.serviceAccount.resolveActorUserId(tenantId, actor.userId),
    };

    let response: ApiUpsertResponse;
    try {
      const result = await this.upsert.upsertOne(
        tenantId,
        resource,
        connectionId,
        policy,
        externalId,
        data,
        attributedActor,
        { safe: false },
      );
      // A record the platform did NOT apply must never look like success: it is
      // an explicit 409 carrying the conflict details (the conflict itself is
      // already queued for the clinic to review). Thrown inside this try so the
      // idempotency key is released — a retry after the clinic resolves it is
      // re-evaluated rather than replaying a stale refusal.
      if (result.outcome === UPSERT_OUTCOME.CONFLICTED) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: conflictMessage(result.reason),
          publicContext: {
            outcome: UPSERT_OUTCOME.CONFLICTED,
            reason: result.reason ?? CONFLICT_REASON.FIELD_DIVERGENCE,
            externalId: result.externalId,
            internalId: result.internalId,
            changedFields: result.changedFields ?? [],
          },
        });
      }
      response = {
        status: 200,
        body: {
          outcome: result.outcome,
          externalId: result.externalId,
          internalId: result.internalId,
          ...(result.changedFields ? { changedFields: result.changedFields } : {}),
        },
      };
    } catch (err) {
      // Failed before completion — release the idempotency key so a corrected
      // retry with the same key is not permanently blocked.
      await this.idempotency.fail(begin.recordId);
      throw err;
    }

    await this.idempotency.complete(begin.recordId, response.status, response.body);
    await this.connections.markSuccess(connection.id);
    return response;
  }
}
