import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

/**
 * Every outbound email attempt — delivery logging + observability + idempotency.
 * A UNIQUE `idempotency_key` (nullable; Postgres allows multiple NULLs) makes
 * sends replay-safe. No email body/PII is stored, only routing + status.
 */
@Entity('email_logs')
@Index(['status', 'created_at'])
@Index(['tenant', 'created_at']) // P0.7: property renamed tenant_id -> tenant; same underlying column
export class EmailLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * P0.7: was a plain `@Column`; now a relation so the FK
   * `1730089000000-TenantIsolationForeignKeys` adds on this same `tenant_id`
   * column is entity-declared — otherwise a `TYPEORM_SYNCHRONIZE=true` boot
   * would DROP it as "old". Column name/nullability unchanged (`@JoinColumn`
   * pins `tenant_id`, not TypeORM's camelCase default); the `@Index` above
   * still refers to it by its column name, which `@JoinColumn` preserves.
   * The two write sites in `email-delivery.service.ts` are updated alongside
   * this.
   */
  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column()
  to_address!: string;

  @Column()
  template!: string;

  @Column({ nullable: true })
  subject?: string;

  @Column({ default: 'en' })
  locale!: string;

  /** QUEUED | SENT | FAILED */
  @Column({ default: 'QUEUED' })
  status!: string;

  @Column({ nullable: true })
  provider?: string;

  @Column({ nullable: true })
  provider_message_id?: string;

  @Column({ type: 'text', nullable: true })
  error?: string;

  @Index({ unique: true })
  @Column({ nullable: true })
  idempotency_key?: string;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at?: Date;
}
