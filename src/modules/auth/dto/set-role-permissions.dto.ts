import { ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Replaces the full set of permissions on a role with the provided list
 * (idempotent set semantics).
 */
export class SetRolePermissionsDto {
  @ApiProperty({
    description:
      'Complete set of permission UUIDs to assign to the role. This **replaces** the existing set entirely — it is not additive. Pass an empty array to remove all permissions.',
    example: [
      'b2c3d4e5-0000-0000-0000-000000000020',
      'b2c3d4e5-0000-0000-0000-000000000021',
    ],
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  permissionIds!: string[];
}
