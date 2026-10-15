import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('system_settings')
export class SystemSetting {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120, unique: true })
  key!: string;

  @Column({ type: 'jsonb', nullable: true })
  value?: any;

  @UpdateDateColumn()
  updated_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}