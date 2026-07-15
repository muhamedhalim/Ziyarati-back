import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Role comparison request. Both ids are validated UUIDs; the service rejects
 * comparing a role against itself. Comparison is computed purely from
 * role→permission relations (by id), never from role names.
 */
export class CompareRolesDto {
  @ApiProperty({ format: 'uuid', description: 'First role id (Role A).' })
  @IsUUID() roleA!: string;

  @ApiProperty({ format: 'uuid', description: 'Second role id (Role B).' })
  @IsUUID() roleB!: string;
}
