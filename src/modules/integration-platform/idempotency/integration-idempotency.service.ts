import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { createHash } from 'node:crypto';

import { IntegrationIdempotencyKey } from '../../../entities/Integration/IntegrationIdempotencyKey';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';

/** TTL for a stored idempotency record. */
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

/** Matches the `idempotency_key` varchar(255) column and the published contract. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const IDEMPOTENCY_KEY_RE = /^[!-~]+$/;

/**
 * Validate a caller-supplied `Idempotency-Key` BEFORE it reaches the database
 * (an over-long value used to surface as a 500 DATABASE_ERROR). 1–255 printable
 * ASCII characters, no whitespace or control characters. Absent/empty = no dedupe.
 */
export function assertValidIdempotencyKey(key: string | undefined): void {
  if (key === undefined || key === '') return;
  if (
    typeof key !== 'string' ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_RE.test(key)
  ) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Idempotency-Key must be 1–${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters without spaces`,
      publicContext: { header: 'Idempotency-Key', maxLength: IDEMPOTENCY_KEY_MAX_LENGTH },
    });
  }
}

export interface IdempotencyBeginResult {
  /** A prior COMPLETED result exists for this key+payload — return it verbatim. */
  replay?: { status: number; body: Record<string, unknown> };
  /** The row id to complete() once the operation finishes (absent when replayed). */
  recordId?: string;
}

/**
 * Retry-safe write dedupe for the integration write/upsert API (Phase 3).
 *
 * Contract:
 *  - No key presented → caller proceeds without dedupe (returns `{}`).
 *  - Key + same payload, prior COMPLETED → returns the stored response (replay).
 *  - Key + same payload, still IN_PROGRESS → 409 (a concurrent retry is racing).
 *  - Key + DIFFERENT payload → 422 (key reuse with a different body is a bug/attack).
 *  - A record past its `expires_at` is treated as ABSENT at lookup even if the
 *    daily purge has not run (the documented window is 24 h). It is removed with
 *    a conditional delete and the normal insert path runs, so the unique index
 *    still collapses concurrent retries.
 *
 * Correctness under races relies on the unique index (tenant, idempotency_key):
 * two concurrent begins collapse to one inserted row; the loser re-reads and
 * branches on the winner's state.
 */
@Injectable()
export class IntegrationIdempotencyService {
  private readonly logger = new Logger(IntegrationIdempotencyService.name);

  constructor(
    @InjectRepository(IntegrationIdempotencyKey)
    private readonly repo: Repository<IntegrationIdempotencyKey>,
  ) {}

  /** Stable SHA-256 of a request payload (key-sorted) for reuse detection. */
  hashPayload(payload: unknown): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  async begin(
    tenantId: string,
    connectionId: string | null,
    key: string | undefined,
    endpoint: string,
    requestHash: string,
    now: Date = new Date(),
  ): Promise<IdempotencyBeginResult> {
    if (!key) return {};

    let existing: IntegrationIdempotencyKey | null = await this.repo.findOne({
      where: { tenant: { id: tenantId }, idempotency_key: key },
    });
    if (existing && existing.expires_at && existing.expires_at.getTime() <= now.getTime()) {
      // Expired → absent. The delete is conditional on expiry so a row that was
      // replaced in the meantime is never removed.
      await this.repo.delete({ id: existing.id, expires_at: LessThanOrEqual(now) });
      existing = null;
    }
    if (existing) return this.branchExisting(existing, requestHash);

    try {
      const saved = await this.repo.save(
        this.repo.create({
          tenant: { id: tenantId } as Tenant,
          connection: connectionId ? ({ id: connectionId } as IntegrationConnection) : null,
          idempotency_key: key,
          endpoint,
          request_hash: requestHash,
          status: 'in_progress',
          expires_at: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        }),
      );
      return { recordId: saved.id };
    } catch (err) {
      // Lost the insert race — another request created the row first. Re-read
      // and branch on its state instead of double-processing.
      if (isUniqueViolation(err)) {
        const winner = await this.repo.findOne({
          where: { tenant: { id: tenantId }, idempotency_key: key },
        });
        if (winner) return this.branchExisting(winner, requestHash);
      }
      throw err;
    }
  }

  /**
   * Remove an in-flight record after the operation FAILED, so a corrected retry
   * with the same key is not permanently blocked by a stale in_progress row.
   * No-op without a record.
   */
  async fail(recordId: string | undefined): Promise<void> {
    if (!recordId) return;
    await this.repo
      .delete({ id: recordId })
      .catch((e) => this.logger.warn(`idempotency fail cleanup failed: ${(e as Error)?.message}`));
  }

  /**
   * Retention sweep — delete idempotency records past their TTL so the table
   * cannot grow unbounded. Safe to run repeatedly; returns the number removed.
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const res = await this.repo
      .createQueryBuilder()
      .delete()
      .from(IntegrationIdempotencyKey)
      .where('expires_at < :now', { now })
      .execute()
      .catch((e) => {
        this.logger.warn(`idempotency purge failed: ${(e as Error)?.message}`);
        return { affected: 0 } as { affected?: number | null };
      });
    return res.affected ?? 0;
  }

  /** Persist the final response so a later retry replays it. No-op without a record. */
  async complete(
    recordId: string | undefined,
    status: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!recordId) return;
    await this.repo
      .update(
        { id: recordId },
        // Cast the jsonb payload: TypeORM's QueryDeepPartialEntity does not
        // accept an index-signature object with `unknown` values.
        { status: 'completed', response_status: status, response_body: body as Record<string, any> },
      )
      .catch((e) => this.logger.warn(`idempotency complete failed: ${(e as Error)?.message}`));
  }

  private branchExisting(
    row: IntegrationIdempotencyKey,
    requestHash: string,
  ): IdempotencyBeginResult {
    if (row.request_hash !== requestHash) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Idempotency-Key was already used with a different request payload',
      });
    }
    if (row.status === 'completed') {
      return {
        replay: { status: row.response_status ?? 200, body: row.response_body ?? {} },
      };
    }
    // Same payload, still in flight elsewhere.
    throw new AppError(ErrorCode.CONFLICT, {
      message: 'A request with this Idempotency-Key is already being processed',
    });
  }
}

/** Deterministic JSON stringify with sorted keys so equal payloads hash equal. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
