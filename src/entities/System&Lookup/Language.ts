import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('languages')
export class Language {
@PrimaryGeneratedColumn('identity')
id!: number;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  @Column({ type: 'varchar', length: 10, unique: true })
  code!: string;

  @Column({ default: false })
  is_rtl!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}