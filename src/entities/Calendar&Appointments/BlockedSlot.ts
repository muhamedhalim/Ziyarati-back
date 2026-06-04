import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { StaffProfile } from '../Staff/StaffProfile';

@Entity('blocked_slots')
export class BlockedSlot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, {
    nullable: true,
  })
  branch?: Branch;

  @ManyToOne(() => StaffProfile, {
    nullable: true,
  })
  staff?: StaffProfile;

  @Column({
    type: 'timestamptz',
  })
  start_time!: Date;

  @Column({
    type: 'timestamptz',
  })
  end_time!: Date;

  @Column({
    type: 'text',
    nullable: true,
  })
  reason?: string;

  @CreateDateColumn()
  created_at!: Date;
}