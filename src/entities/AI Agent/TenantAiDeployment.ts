import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-tenant AI deployment binding for DATA RESIDENCY (a compliance policy, not
 * an execution mode). Lets a tenant be pinned to a regional OpenAI deployment:
 * its own Project, API key, base URL, and the region(s) permitted for its data.
 *
 * IMPORTANT compliance rules (enforced by AiDataResidencyService):
 *  - Disabled by default (`enabled = false`) and additionally gated by the
 *    platform flag AI_DATA_RESIDENCY_ENABLED. With residency off, the global
 *    default OpenAI client is used and this table is ignored.
 *  - When a tenant REQUIRES a region that is not configured/available, requests
 *    FAIL CLOSED — they are never silently redirected to the global deployment.
 *  - Do NOT claim data stays in any particular country unless the deployment and
 *    contract actually support it; `region` is descriptive metadata only.
 *
 * `api_key_ciphertext` is encrypted at rest via EncryptionService (aes-256-gcm);
 * the plaintext key is never logged and never returned by any read endpoint.
 */
@Entity('tenant_ai_deployments')
@Unique('uq_tenant_ai_deployment_tenant', ['tenant_id'])
export class TenantAiDeployment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  @Column({ length: 40, default: 'openai' })
  provider!: string;

  /** Descriptive region label (e.g. 'eu', 'us'); NOT a legal guarantee. */
  @Column({ length: 40, nullable: true })
  region?: string | null;

  /** Regional API base URL for this deployment (e.g. Azure/OpenAI regional). */
  @Column({ type: 'text', nullable: true })
  base_url?: string | null;

  /** OpenAI Project id scoping usage/billing for this tenant. */
  @Column({ length: 120, nullable: true })
  openai_project?: string | null;

  /** Encrypted (aes-256-gcm) API key. Never returned in plaintext. */
  @Column({ type: 'text', nullable: true })
  api_key_ciphertext?: string | null;

  /** Regions this tenant's data is permitted to be processed in. */
  @Column({ type: 'text', array: true, nullable: true })
  allowed_regions?: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
