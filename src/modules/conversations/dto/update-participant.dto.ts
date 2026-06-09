import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Intended participant role/status update.
 *
 * ⚠️ Schema note: the finalized `conversation_participants` table has only
 * `conversation`, `user` and `joined_at` — there is NO role or status column.
 * A participant's role is therefore DERIVED from the user's RBAC role, and this
 * DTO is a forward-compatibility placeholder: the update endpoint documents that
 * role/status are not persisted by the current schema (would require a
 * migration). Adding columns here would violate the "do not change the schema"
 * constraint.
 */
export class UpdateParticipantDto {
  @ApiPropertyOptional({
    description: 'Intended participant role (NOT persisted — derived from the user\'s RBAC role).',
    enum: ['admin', 'agent', 'customer'],
    example: 'agent',
  })
  @IsOptional()
  @IsIn(['admin', 'agent', 'customer'])
  role?: string;

  @ApiPropertyOptional({
    description: 'Intended participant status (NOT persisted by the current schema).',
    enum: ['active', 'inactive'],
    example: 'active',
  })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;
}
