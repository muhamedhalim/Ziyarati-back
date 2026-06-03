import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * Replaces the full set of permissions on a role with the provided list
 * (idempotent set semantics).
 */
export class SetRolePermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  permissionIds!: string[];
}
