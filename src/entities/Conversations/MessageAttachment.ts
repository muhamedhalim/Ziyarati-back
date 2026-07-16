import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Message } from './Message';
import { Tenant } from '../SaaS-Core/Tenant';

@Entity('message_attachments')
// Inbound media is attached by a retryable worker job; this index backs the
// "did I already store this?" lookup on every attempt.
@Index('IDX_message_attachment_provider_media', ['message', 'provider_media_id'])
export class MessageAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Message, {
    onDelete: 'CASCADE',
  })
  message!: Message;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  /**
   * Object KEY in the private bucket (not a public URL) — reads go through
   * short-lived signed URLs. NULL when the file could not be stored (e.g. an
   * unsupported inbound type): the attachment is still recorded so the
   * conversation shows that something was sent.
   */
  @Column({ type: 'text', nullable: true })
  file_url?: string;

  @Column({ length: 50, nullable: true })
  file_type?: string;

  @Column({ length: 255, nullable: true })
  file_name?: string;

  /**
   * The provider's media id (Meta's, for WhatsApp). The idempotency key for
   * inbound media download: it is stable across retries and, unlike
   * `file_name`, always present — WhatsApp media frequently arrives unnamed,
   * and two photos in one conversation can share a filename.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  provider_media_id?: string;

  @CreateDateColumn()
  created_at!: Date;
}