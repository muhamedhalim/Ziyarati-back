import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsIn, ValidateNested } from 'class-validator';

import { SegmentRuleDto } from './segment-rule.dto';
import type { SegmentMatch } from '../segment.constants';

/** A rule set — saved or not yet saved — previewed before committing. */
export class PreviewSegmentDto {
  @ApiProperty({ type: [SegmentRuleDto] })
  @ValidateNested({ each: true })
  @Type(() => SegmentRuleDto)
  @ArrayMaxSize(20)
  rules!: SegmentRuleDto[];

  @ApiProperty({ enum: ['ALL', 'ANY'] })
  @IsIn(['ALL', 'ANY'])
  match!: SegmentMatch;
}
