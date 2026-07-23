import { Injectable } from '@nestjs/common';

import { IntegrationResource } from './integration-platform.constants';
import { IntegrationConnectionService } from './integration-connection.service';
import { IntegrationIdempotencyService } from './integration-idempotency.service';
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
  ) {}

  async upsertViaApi(
    tenantId: string,
    resource: IntegrationResource,
    connectionId: string,
    externalId: string,
    data: Record<string, unknown>,
    idempotencyKey: string | undefined,
    actor: UpsertActor,
  ): Promise<ApiUpsertResponse> {
    const connection = await this.connections.requireActive(tenantId, connectionId);
    const policy = this.connections.conflictPolicyOf(connection);

    const endpoint = `${resource}.upsert`;
    const requestHash = this.idempotency.hashPayload({ resource, connectionId, externalId, data });
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
