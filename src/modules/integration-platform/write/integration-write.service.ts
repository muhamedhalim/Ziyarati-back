import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  ADMISSION_OP,
  IntegrationResource,
  MAX_UPSERT_PAYLOAD_BYTES,
} from '../integration-platform.constants';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationIdempotencyService } from '../idempotency/integration-idempotency.service';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationUpsertService, UpsertActor } from './integration-upsert.service';

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

    let response: ApiUpsertResponse;
    try {
      const result = await this.upsert.upsertOne(
        tenantId,
        resource,
        connectionId,
        policy,
        externalId,
        data,
        actor,
        { safe: false },
      );
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
