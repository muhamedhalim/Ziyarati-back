export enum CommissionType {
  PERCENT = 'PERCENT',
  FIXED = 'FIXED',
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { StaffProfile } from './StaffProfile';
import { Service } from '../Services/Service';

@Entity('staff_commissions')
export class StaffCommission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(
    () => StaffProfile,
    (staff) => staff.commissions,
    {
      onDelete: 'CASCADE',
    },
  )
  staff!: StaffProfile;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Service, {
    nullable: true,
  })
  service?: Service;

  @Column({
    type: 'enum',
    enum: CommissionType,
  })
  commission_type!: CommissionType;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  commission_value!: number;

  @CreateDateColumn()
  created_at!: Date;
}