import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateBranchDto } from './create-branch.dto';

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @ApiPropertyOptional({
    description:
      'Set to `false` to deactivate the branch without deleting it. Inactive branches are hidden from patient-facing booking UIs but their historical data is preserved.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
