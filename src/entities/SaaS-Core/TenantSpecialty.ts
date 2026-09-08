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

import { Tenant } from './Tenant';
import { Specialty } from '../System&Lookup/Specialty';

export enum SpecialtyProvenance {
  DERIVED = 'DERIVED',
  ASSERTED = 'ASSERTED',
}

/**
 * Clinic ↔ specialty association (Marketplace BE-1). `DERIVED` rows come
 * from the backfill (services → specialty); `ASSERTED` rows come from a
 * platform-admin correction (T056) and must never be overwritten or deleted
 * by a re-run of the backfill.
 */
@Entity('tenant_specialties')
@Unique(['tenant', 'specialty'])
@Index(['specialty'])
@Index(['tenant'])
export class TenantSpecialty {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  tenant!: Tenant;

  @ManyToOne(() => Specialty, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  specialty!: Specialty;

  @Column({
    type: 'enum',
    enum: SpecialtyProvenance,
    enumName: 'tenant_specialty_provenance_enum',
  })
  provenance!: SpecialtyProvenance;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
