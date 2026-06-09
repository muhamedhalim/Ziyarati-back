import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Assigns a conversation to a staff user (agent). Sets status to ASSIGNED. */
export class AssignConversationDto {
  @ApiProperty({
    description: 'User (agent) to assign the conversation to. Must belong to the caller\'s tenant.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
  })
  @IsUUID()
  assignedToUserId!: string;
}
