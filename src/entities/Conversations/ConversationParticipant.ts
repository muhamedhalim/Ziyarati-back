import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  CreateDateColumn,
  Unique,
} from 'typeorm';

import { Conversation } from './Conversation';
import { User } from '../Auth&RBAC/User';

@Entity('conversation_participants')
@Unique(['conversation', 'user'])
export class ConversationParticipant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Conversation, {
    onDelete: 'CASCADE',
  })
  conversation!: Conversation;

  @ManyToOne(() => User)
  user!: User;

  @CreateDateColumn()
  joined_at!: Date;
}