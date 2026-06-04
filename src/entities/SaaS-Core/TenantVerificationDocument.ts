import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { VerificationDocStatus } from '../enums';

@Entity('tenant_verification_documents')
@Index(['tenant'])
export class TenantVerificationDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.verificationDocuments, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  doc_type!: string;

  @Column()
  file_url!: string;

  @Column({
    type: 'enum',
    enum: VerificationDocStatus,
    default: VerificationDocStatus.PENDING,
  })
  status!: VerificationDocStatus;

  @Column({ nullable: true })
  reviewed_by?: string;

  @Column({ nullable: true, type: 'text' })
  review_note?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at!: Date;
}