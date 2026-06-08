import { OmitType, PartialType } from '@nestjs/swagger';
import { CreatePermissionDto } from './create-permission.dto';

/** Slug is immutable; only name/module can be updated. */
export class UpdatePermissionDto extends PartialType(
  OmitType(CreatePermissionDto, ['slug'] as const),
) {}
