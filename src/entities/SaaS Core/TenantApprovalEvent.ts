import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Tenant } from '../SaaS Core/Tenant';

@Entity('tenant_approval_events')
@Index(['tenant', 'created_at'])
export class TenantApprovalEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.approvalEvents, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  action!: string;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  @Column()
  acted_by!: string;

  @CreateDateColumn()
  created_at!: Date;
}