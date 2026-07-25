import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

/**
 * One external system (PMS/EMR/ERP/CRM) a clinic has connected to the platform
 * (Phase 3 — two-way integrations). A tenant may hold MANY connections safely;
 * every mapping, idempotency key, import and sync is scoped to exactly one
 * connection, so two external systems can never collide or read each other's
 * state.
 *
 * `credentials_ciphertext` is stored ENCRYPTED (EncryptionService, AES-256-GCM)
 * and is NEVER returned to any client — only used server-side when the platform
 * must authenticate to the external system. `provider` references a key in the
 * trusted INTEGRATION_PROVIDERS registry; endpoints/OAuth config for a provider
 * come from backend configuration only, never from tenant input (SSRF defense).
 */
@Entity('integration_connections')
@Index(['tenant'])
export class IntegrationConnection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** Provider key from INTEGRATION_PROVIDERS (e.g. `generic_rest`). */
  @Column({ type: 'varchar', length: 60 })
  provider!: string;

  /** active | inactive | disconnected | error */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: string;

  /** none | api_key | secret | oauth2 */
  @Column({ type: 'varchar', length: 20, default: 'none' })
  auth_type!: string;

  /** Encrypted provider credential (bearer/secret). Never serialized to clients. */
  @Column({ type: 'text', nullable: true })
  credentials_ciphertext?: string | null;

  /** Non-secret connection settings (never credentials). */
  @Column({ type: 'jsonb', nullable: true })
  config?: Record<string, unknown> | null;

  // ── OAuth2 token storage (Phase 4) ────────────────────────────────────────
  // All three token columns are ENCRYPTED and NEVER serialized to any client —
  // the API exposes only presence/expiry. Refresh ROTATION replaces the stored
  // refresh token on every successful refresh, so a leaked older token is
  // useless once rotated.

  /** Encrypted OAuth access token. */
  @Column({ type: 'text', nullable: true })
  oauth_access_token_ciphertext?: string | null;

  /** Encrypted OAuth refresh token (rotated on each refresh). */
  @Column({ type: 'text', nullable: true })
  oauth_refresh_token_ciphertext?: string | null;

  /** Access-token expiry — drives proactive refresh and the UI's expiry state. */
  @Column({ type: 'timestamptz', nullable: true })
  oauth_expires_at?: Date | null;

  /** Scopes the provider actually granted (may be narrower than requested). */
  @Column({ type: 'text', nullable: true })
  oauth_scope?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  oauth_connected_at?: Date | null;

  /** Last successful refresh — for operator visibility into rotation. */
  @Column({ type: 'timestamptz', nullable: true })
  oauth_refreshed_at?: Date | null;

  /** inbound | outbound | bidirectional */
  @Column({ type: 'varchar', length: 20, default: 'bidirectional' })
  sync_direction!: string;

  /** external_wins | platform_wins | reject_and_report */
  @Column({ type: 'varchar', length: 20, default: 'reject_and_report' })
  default_conflict_policy!: string;

  @Column({ type: 'timestamptz', nullable: true })
  last_success_at?: Date | null;

  /** Safe, truncated last-error summary (never secrets or full records). */
  @Column({ type: 'text', nullable: true })
  last_error?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_error_at?: Date | null;

  /**
   * Count of consecutive failed communications since the last success. Drives the
   * healthy → degraded → offline transition (health is NEVER inferred from row
   * existence alone). Reset to 0 on any success.
   */
  @Column({ type: 'int', default: 0 })
  consecutive_failures!: number;

  /** Last measured round-trip latency to the provider, in ms (when measured). */
  @Column({ type: 'int', nullable: true })
  last_latency_ms?: number | null;

  /**
   * Soft-delete marker. "Disconnect + delete" sets this (+ status disconnected)
   * rather than removing the row — mappings and history reference this
   * connection and must survive its removal for audit. Tenant-facing reads
   * filter `deleted_at IS NULL`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  deleted_at?: Date | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
