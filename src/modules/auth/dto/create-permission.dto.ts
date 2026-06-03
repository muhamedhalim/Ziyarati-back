import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreatePermissionDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9:._-]+$/, {
    message: 'slug must be lowercase (e.g. "appointments:create")',
  })
  slug!: string;

  /** Logical grouping, e.g. "appointments", "payments". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  module?: string;
}
