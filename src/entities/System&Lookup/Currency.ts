import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('currencies')
export class Currency {
@PrimaryGeneratedColumn('identity')
id!: number;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  @Column({ type: 'varchar', length: 10, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 5, nullable: true })
  symbol?: string;

  @CreateDateColumn()
  created_at!: Date;
}