import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetResourceCatalogActiveDto {
  @ApiProperty({
    description:
      'Activating refuses (422) unless the item is priced (unitPriceMinor > 0), structurally sellable (not eligibility: "blocked" in the registry), and at least one active plan has a Finite limit for its plan column.',
  })
  @IsBoolean()
  isActive!: boolean;
}
