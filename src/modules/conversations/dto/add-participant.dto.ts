import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Adds a staff user as a conversation participant. Participants are Users
 * (agents/admins); the customer side is represented by the conversation's
 * `customer`. Idempotent via the unique (conversation, user) constraint.
 */
export class AddParticipantDto {
  @ApiProperty({
    description: 'User to add as a participant. Must belong to the caller\'s tenant.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000002',
  })
  @IsUUID()
  userId!: string;
}
