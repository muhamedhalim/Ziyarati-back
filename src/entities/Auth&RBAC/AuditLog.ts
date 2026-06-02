import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { User } from '../Auth&RBAC/User';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: true,
  })
  tenant?: Tenant;

  @ManyToOne(() => User, {
    nullable: true,
  })
  user?: User;

  @Column()
  action!: string;

  @Column()
  entity_type!: string;

  @Column({
    type: 'uuid',
    nullable: true,
  })
  entity_id?: string;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  old_values?: Record<string, any>;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  new_values?: Record<string, any>;

  @Column({
    nullable: true,
  })
  ip_address?: string;

  @CreateDateColumn({
    type: 'timestamptz',
  })
  created_at!: Date;
}