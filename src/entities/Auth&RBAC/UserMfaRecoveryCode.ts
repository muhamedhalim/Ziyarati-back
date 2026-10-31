import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Single-use recovery code for a user's MFA. Only a hash is stored. */
@Entity('user_mfa_recovery_codes')
export class UserMfaRecoveryCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @Column({ type: 'text' })
  code_hash!: string;

  @Column({ type: 'timestamptz', nullable: true })
  used_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
