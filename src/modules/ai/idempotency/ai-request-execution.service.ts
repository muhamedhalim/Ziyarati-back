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

/**
 * How long a claim may sit in STARTED / PROVIDER_IN_PROGRESS before the turn
 * that took it is presumed dead (worker crash, deploy, lost connection). Must
 * exceed the longest realistic turn — including the WhatsApp turn deadline —
 * or a second worker could take over a turn that is still running.
 */
export const AI_REQUEST_STALE_MS_DEFAULT = 3 * 60_000;

export function aiRequestStaleMs(): number {
  const n = Number(process.env.AI_REQUEST_STALE_MS);
  return Number.isFinite(n) && n >= 1000 ? n : AI_REQUEST_STALE_MS_DEFAULT;
}

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
        `SELECT state, (updated_at < now() - ($3::int * interval '1 millisecond')) AS stale FROM ai_request_executions WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [tenantId, key, aiRequestStaleMs()],
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
      // A claim nobody has touched for AI_REQUEST_STALE_MS belongs to a turn
      // that died. Before the provider was called nothing happened, so the work
      // is simply ours to redo; after, the outcome is unknowable, so it is
      // closed as UNKNOWN_OUTCOME rather than risk a duplicate provider call.
      if (row?.stale && row.state === AI_REQUEST_STATE.STARTED) {
        await m.query(
          `UPDATE ai_request_executions SET updated_at=now() WHERE tenant_id=$1 AND idempotency_key=$2`,
          [tenantId, key],
        );
        return 'CLAIMED';
      }
      if (row?.stale && row.state === AI_REQUEST_STATE.PROVIDER_IN_PROGRESS) {
        await m.query(
          `UPDATE ai_request_executions SET state='UNKNOWN_OUTCOME', error_code='STALE_CLAIM', updated_at=now() WHERE tenant_id=$1 AND idempotency_key=$2`,
          [tenantId, key],
        );
        return 'UNKNOWN';
      }
      return 'IN_FLIGHT';
    });
  }

  /** Has this key ever been claimed? Read-only; takes no lock and changes nothing. */
  async exists(tenantId: string, key: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM ai_request_executions WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1`,
      [tenantId, key],
    );
    return rows.length > 0;
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
