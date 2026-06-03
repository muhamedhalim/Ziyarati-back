import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateRoleDto } from './create-role.dto';

/**
 * Slug is immutable after creation (it's referenced by code and guards), so it
 * is omitted from the updatable surface.
 */
export class UpdateRoleDto extends PartialType(
  OmitType(CreateRoleDto, ['slug'] as const),
) {}
