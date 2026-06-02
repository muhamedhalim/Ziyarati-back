import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  CreateDateColumn,
  Unique,
  Column,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { User } from '../Auth&RBAC/User';

@Entity('branch_users')
@Unique(['branch', 'user'])
export class BranchUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, {
    onDelete: 'CASCADE',
  })
  branch!: Branch;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
  })
  user!: User;

  @Column({ default: false })
  is_primary!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}