import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Country } from './Country';

@Entity('cities')
export class City {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Country)
  country!: Country;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name_ar?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name_en?: string;

  @CreateDateColumn()
  created_at!: Date;
}