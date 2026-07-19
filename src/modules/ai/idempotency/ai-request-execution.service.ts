import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export const AI_REQUEST_STATE = {
  STARTED: 'STARTED',
  PROVIDER_IN_PROGRESS: 'PROVIDER_IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_PERMANENT: 'FAILED_PERMANENT',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
} as const;

@Injectable()
export class AiRequestExecutionService {
  constructor(private readonly dataSource: DataSource) {}

  async claim(tenantId: string, key: string, feature: string, channel: string): Promise<'CLAIMED' | 'COMPLETED' | 'IN_FLIGHT' | 'UNKNOWN'> {
    return this.dataSource.transaction(async (m) => {
      const inserted = await m.query(
        `INSERT INTO ai_request_executions (tenant_id, idempotency_key, feature, channel, state)
         VALUES ($1,$2,$3,$4,'STARTED') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
        [tenantId, key, feature, channel],
      );
      if (inserted[0]?.id) return 'CLAIMED';
      const [row] = await m.query(
        `SELECT state FROM ai_request_executions WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [tenantId, key],
      );
      if (row?.state === AI_REQUEST_STATE.COMPLETED) return 'COMPLETED';
      if (row?.state === AI_REQUEST_STATE.UNKNOWN_OUTCOME) return 'UNKNOWN';
      if (row?.state === AI_REQUEST_STATE.FAILED_RETRYABLE) {
        await m.query(
          `UPDATE ai_request_executions SET state='STARTED', error_code=NULL, updated_at=now() WHERE tenant_id=$1 AND idempotency_key=$2`,
          [tenantId, key],
        );
        return 'CLAIMED';
      }
      return 'IN_FLIGHT';
    });
  }

  async markProviderStarted(tenantId: string, key: string): Promise<void> {
    await this.setState(tenantId, key, AI_REQUEST_STATE.PROVIDER_IN_PROGRESS);
  }

  async complete(tenantId: string, key: string, response: unknown): Promise<void> {
    await this.dataSource.query(
      `UPDATE ai_request_executions SET state='COMPLETED',response_json=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, key, JSON.stringify(response)],
    );
  }

  async completedResponse<T>(tenantId: string, key: string): Promise<T | undefined> {
    const [row] = await this.dataSource.query(
      `SELECT response_json FROM ai_request_executions WHERE tenant_id=$1 AND idempotency_key=$2 AND state='COMPLETED'`,
      [tenantId, key],
    );
    return row?.response_json as T | undefined;
  }

  async fail(tenantId: string, key: string, state: 'FAILED_RETRYABLE' | 'FAILED_PERMANENT' | 'UNKNOWN_OUTCOME', errorCode: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ai_request_executions SET state=$3,error_code=$4,updated_at=now() WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, key, state, errorCode],
    );
  }

  private async setState(tenantId: string, key: string, state: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ai_request_executions SET state=$3,updated_at=now() WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, key, state],
    );
  }
}
