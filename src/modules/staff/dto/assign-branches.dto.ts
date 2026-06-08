import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Replaces the set of branches a staff member is assigned to (via the
 * `branch_users` join). Each branch must belong to the caller's clinic.
 */
export class AssignBranchesDto {
  @ApiProperty({
    description:
      'Complete list of branch UUIDs the staff member works at. This REPLACES the existing assignments.',
    example: [
      'c1d2e3f4-0000-0000-0000-000000000010',
      'c1d2e3f4-0000-0000-0000-000000000011',
    ],
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  branchIds!: string[];

  @ApiPropertyOptional({
    description:
      'Which branch is the staff member\'s primary location. Must be one of `branchIds`. The first branch is used if omitted.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsOptional()
  @IsUUID()
  primaryBranchId?: string;
}
