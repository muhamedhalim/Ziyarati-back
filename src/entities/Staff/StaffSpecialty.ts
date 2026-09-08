import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Unique,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { StaffProfile } from './StaffProfile';
import { Specialty } from '../System&Lookup/Specialty';
import { SpecialtyProvenance } from '../SaaS-Core/TenantSpecialty';

/**
 * Doctor ↔ specialty association (Marketplace BE-1). `tenant` is
 * denormalised (same value as `staff.tenant`) so tenant-isolation checks and
 * tenant-scoped queries never need to join through `staff_profiles` first —
 * the same pattern `StaffService.tenant` already uses.
 */
@Entity('staff_specialties')
@Unique(['staff', 'specialty'])
@Index(['specialty'])
export class StaffSpecialty {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => StaffProfile, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  staff!: StaffProfile;

  @ManyToOne(() => Specialty, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  specialty!: Specialty;

  @ManyToOne(() => Tenant, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  tenant!: Tenant;

  @Column({
    type: 'enum',
    enum: SpecialtyProvenance,
    enumName: 'staff_specialty_provenance_enum',
  })
  provenance!: SpecialtyProvenance;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
