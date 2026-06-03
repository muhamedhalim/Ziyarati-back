import {
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must be lowercase alphanumeric with dashes',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Permission slugs to grant to the role on creation. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissionSlugs?: string[];
}
