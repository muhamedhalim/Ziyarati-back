import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('countries')
export class Country {
@PrimaryGeneratedColumn('identity')
id!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name_ar?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name_en?: string;

  @Column({ type: 'varchar', length: 3, unique: true, nullable: true })
  code?: string;

  @CreateDateColumn()
  created_at!: Date;
}