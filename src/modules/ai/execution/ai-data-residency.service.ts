import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantAiDeployment } from '../../../entities/AI Agent/TenantAiDeployment';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * The connection options a per-tenant regional deployment must be dialed with.
 * `apiKey` is the DECRYPTED key — it must never be logged.
 */
export interface ResidencyClientOptions {
  apiKey: string;
  baseURL?: string;
  project?: string;
}

export interface ResidencyDecision {
  /**
   * true → the tenant REQUIRES a regional deployment and it resolved cleanly;
   * the caller MUST dial `options`. false → residency is off / not required for
   * this tenant; the caller uses the global default client.
   */
  enforced: boolean;
  region: string | null;
  deploymentId: string | null;
  options: ResidencyClientOptions | null;
}

const NOT_ENFORCED: ResidencyDecision = {
  enforced: false,
  region: null,
  deploymentId: null,
  options: null,
};

/**
 * Data Residency — a COMPLIANCE policy (where data is processed), orthogonal to
 * the execution mode (Standard/Batch). It resolves, per tenant, whether a
 * regional OpenAI deployment must be used and with what connection options.
 *
 * Guarantees (per the requirement):
 *  - Disabled by default: gated by AI_DATA_RESIDENCY_ENABLED (default false). Off
 *    ⇒ every tenant uses the global default client; this table is ignored.
 *  - FAIL CLOSED: when a tenant's deployment is enabled but misconfigured
 *    (missing/invalid region or key, region not in the allow-list, key
 *    undecryptable) the request FAILS — it is NEVER silently redirected to the
 *    global deployment.
 *  - No location claims: `region` is descriptive metadata only.
 *  - The decrypted API key is never logged.
 */
@Injectable()
export class AiDataResidencyService {
  private readonly logger = new Logger(AiDataResidencyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    @InjectRepository(TenantAiDeployment)
    private readonly deployments: Repository<TenantAiDeployment>,
  ) {}

  /** Platform master switch. Default OFF. */
  isEnabled(): boolean {
    return String(this.config.get('AI_DATA_RESIDENCY_ENABLED', 'false')) === 'true';
  }

  /**
   * Resolve the residency decision for a tenant. Throws (fail closed) when the
   * tenant requires residency but its deployment cannot be honored.
   */
  async resolve(tenantId: string): Promise<ResidencyDecision> {
    if (!this.isEnabled()) return NOT_ENFORCED;

    const deployment = await this.deployments.findOne({ where: { tenant_id: tenantId } });
    // No row, or explicitly disabled ⇒ this tenant does not require residency.
    if (!deployment || !deployment.enabled) return NOT_ENFORCED;

    // From here the tenant REQUIRES a regional deployment — any gap fails closed.
    const region = deployment.region?.trim() || null;
    if (!region) {
      this.failClosed(tenantId, 'no region configured on the enabled deployment');
    }
    if (deployment.allowed_regions?.length && !deployment.allowed_regions.includes(region!)) {
      this.failClosed(tenantId, `region "${region}" is not in the tenant allow-list`);
    }
    if (!deployment.api_key_ciphertext) {
      this.failClosed(tenantId, 'no API key configured on the enabled deployment');
    }

    let apiKey: string;
    try {
      apiKey = this.encryption.decrypt(deployment.api_key_ciphertext!);
    } catch {
      // Never echo the underlying crypto error (leaks key/config detail).
      this.failClosed(tenantId, 'the deployment API key could not be decrypted');
    }
    if (!apiKey!.trim()) {
      this.failClosed(tenantId, 'the deployment API key is empty');
    }

    return {
      enforced: true,
      region,
      deploymentId: deployment.id,
      options: {
        apiKey: apiKey!,
        baseURL: deployment.base_url?.trim() || undefined,
        project: deployment.openai_project?.trim() || undefined,
      },
    };
  }

  private failClosed(tenantId: string, reason: string): never {
    this.logger.error(`AI data residency fail-closed for tenant ${tenantId}: ${reason}`);
    throw new AppError(ErrorCode.FORBIDDEN, {
      message:
        'AI data residency is required for this tenant but its regional deployment is unavailable. ' +
        'The request was refused rather than processed in the global region.',
      context: { reason: 'DATA_RESIDENCY_UNAVAILABLE' },
    });
  }
}
