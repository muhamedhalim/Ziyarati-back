import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Service } from './Service';

@Entity('service_resources')
export class ServiceResource {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(
    () => Service,
    (service) => service.resources,
    {
      onDelete: 'CASCADE',
    },
  )
  service!: Service;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    nullable: true,
  })
  name?: string;

  @Column({
    nullable: true,
  })
  type?: string;

  @CreateDateColumn()
  created_at!: Date;
}