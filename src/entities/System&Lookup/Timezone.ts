import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('timezones')
export class Timezone {
@PrimaryGeneratedColumn('identity')
id!: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  name!: string;

  @Column({ type: 'varchar', length: 10 })
  offset!: string;

  @CreateDateColumn()
  created_at!: Date;
}