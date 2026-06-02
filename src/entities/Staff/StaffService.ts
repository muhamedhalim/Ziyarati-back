import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Unique,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { StaffProfile } from './StaffProfile';
import { Service } from '../Services/Service';

@Entity('staff_services')
@Unique(['staff', 'service'])
export class StaffService {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(
    () => StaffProfile,
    (staff) => staff.staffServices,
    {
      onDelete: 'CASCADE',
    },
  )
  staff!: StaffProfile;

  @ManyToOne(() => Service, {
    onDelete: 'CASCADE',
  })
  service!: Service;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @CreateDateColumn()
  created_at!: Date;
}