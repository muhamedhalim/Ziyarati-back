import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Every outbound email attempt — delivery logging + observability + idempotency.
 * A UNIQUE `idempotency_key` (nullable; Postgres allows multiple NULLs) makes
 * sends replay-safe. No email body/PII is stored, only routing + status.
 */
@Entity('email_logs')
@Index(['status', 'created_at'])
@Index(['tenant_id', 'created_at'])
export class EmailLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  tenant_id?: string;

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
