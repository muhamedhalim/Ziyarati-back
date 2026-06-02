import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: true })
  tenant?: Tenant; // NULL = platform-level key

  @Column({ type: 'varchar', length: 100, nullable: true })
  name?: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  key_hash!: string;

  @Column({ type: 'jsonb', nullable: true })
  permissions?: any;

  @Column({ type: 'timestamptz', nullable: true })
  last_used_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at?: Date;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}