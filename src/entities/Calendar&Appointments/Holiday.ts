import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';

@Entity('holidays')
export class Holiday {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, {
    nullable: true,
  })
  branch?: Branch;

  @Column({
    nullable: true,
  })
  name?: string;

  @Column({
    type: 'date',
  })
  date!: Date;

  @Column({
    default: false,
  })
  is_recurring!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}