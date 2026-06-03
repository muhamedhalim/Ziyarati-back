import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreatePermissionDto } from './create-permission.dto';

/** Slug is immutable; only name/module can be updated. */
export class UpdatePermissionDto extends PartialType(
  OmitType(CreatePermissionDto, ['slug'] as const),
) {}
