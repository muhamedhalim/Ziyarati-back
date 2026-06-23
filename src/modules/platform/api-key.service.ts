import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { ApiKey } from '../../entities/System/ApiKey';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { QueryApiKeysDto } from './dto/query-api-keys.dto';
import { generateApiKey, hashApiKey } from './platform.constants';

/** API key with the secret hash stripped — the shape returned to clients. */
export type SafeApiKey = Omit<ApiKey, 'key_hash'>;

/** The principal an authenticated API key resolves to. */
export interface AuthenticatedApiKey {
  keyId: string;
  tenantId: string | null;
  permissions: string[];
}

/** Only refresh last_used_at at most this often (avoid a write per request). */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * API keys for external (machine-to-machine) integrations — tenant-owned.
 *
 * Tenant isolation: `api_keys` is tenant-scoped via the `tenant` relation; every
 * query filters `where: { tenant: { id: tenantId } }`. Secrets are stored HASHED
 * (`key_hash`, unique); the plaintext is returned ONCE on create/rotate and
 * never persisted or echoed again. `key_hash` is never serialized to clients.
 *
 * Lifecycle (schema has only `is_active` + `expires_at`, no status/revoked
 * column): deactivate → is_active=false (reversible); activate → is_active=true;
 * revoke → is_active=false AND expires_at=now (permanent — an activate cannot
 * resurrect an expired key).
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger('ApiKeyService');

  constructor(
    @InjectRepository(ApiKey)
    private readonly keys: Repository<ApiKey>,
  ) {}

  async create(
    tenantId: string,
    dto: CreateApiKeyDto,
  ): Promise<SafeApiKey & { apiKey: string }> {
    const { plaintext, hash } = generateApiKey();
    const saved = await this.keys.save(
      this.keys.create({
        tenant: { id: tenantId } as Tenant,
        name: dto.name,
        key_hash: hash,
        permissions: dto.permissions,
        expires_at: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        is_active: true,
      }),
    );
    this.logger.log(`API key ${saved.id} created for tenant ${tenantId}`);
    // Plaintext returned exactly once — it is never stored or retrievable later.
    return { ...this.toSafe(saved), apiKey: plaintext };
  }

  /** Issue a new secret for an existing key (same id/name/permissions). */
  async rotate(
    tenantId: string,
    id: string,
  ): Promise<SafeApiKey & { apiKey: string }> {
    const key = await this.findOneOrThrow(tenantId, id);
    const { plaintext, hash } = generateApiKey();
    key.key_hash = hash;
    const saved = await this.keys.save(key);
    return { ...this.toSafe(saved), apiKey: plaintext };
  }

  /** Permanent disable: inactive + immediately expired. */
  async revoke(tenantId: string, id: string): Promise<SafeApiKey> {
    const key = await this.findOneOrThrow(tenantId, id);
    key.is_active = false;
    key.expires_at = new Date();
    return this.toSafe(await this.keys.save(key));
  }

  async activate(tenantId: string, id: string): Promise<SafeApiKey> {
    const key = await this.findOneOrThrow(tenantId, id);
    key.is_active = true;
    return this.toSafe(await this.keys.save(key));
  }

  async deactivate(tenantId: string, id: string): Promise<SafeApiKey> {
    const key = await this.findOneOrThrow(tenantId, id);
    key.is_active = false;
    return this.toSafe(await this.keys.save(key));
  }

  async get(tenantId: string, id: string): Promise<SafeApiKey> {
    return this.toSafe(await this.findOneOrThrow(tenantId, id));
  }

  async list(tenantId: string, query: QueryApiKeysDto) {
    const where: FindOptionsWhere<ApiKey> = { tenant: { id: tenantId } };
    if (query.isActive !== undefined) where.is_active = query.isActive;

    const [rows, total] = await this.keys.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: rows.map((k) => this.toSafe(k)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Verify a PRESENTED plaintext key (the runtime auth path used by
   * ApiKeyAuthGuard). Constant-work hash lookup → active → not expired. Updates
   * `last_used_at` at most once per minute (throttled, fire-and-forget). Throws
   * UNAUTHORIZED for any failure so callers can't distinguish reasons.
   */
  async authenticate(plaintext: string | undefined): Promise<AuthenticatedApiKey> {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'API key required' });
    }
    const key = await this.keys.findOne({
      where: { key_hash: hashApiKey(plaintext) },
      relations: { tenant: true },
    });
    if (!key || !key.is_active) {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'Invalid or inactive API key' });
    }
    if (key.expires_at && key.expires_at.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'API key has expired' });
    }

    const now = Date.now();
    if (!key.last_used_at || now - key.last_used_at.getTime() > LAST_USED_THROTTLE_MS) {
      void this.keys.update({ id: key.id }, { last_used_at: new Date() }).catch(() => undefined);
    }

    return {
      keyId: key.id,
      tenantId: key.tenant?.id ?? null,
      permissions: Array.isArray(key.permissions) ? (key.permissions as string[]) : [],
    };
  }

  private async findOneOrThrow(tenantId: string, id: string): Promise<ApiKey> {
    const key = await this.keys.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!key) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'API key not found' });
    }
    return key;
  }

  /** Strip the secret hash before returning a key to any client. */
  private toSafe(key: ApiKey): SafeApiKey {
    const { key_hash, ...safe } = key;
    void key_hash;
    return safe;
  }
}
