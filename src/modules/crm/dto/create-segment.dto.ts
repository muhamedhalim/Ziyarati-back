import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { SegmentRuleDto } from './segment-rule.dto';
import type { SegmentMatch } from '../segment.constants';

export class CreateSegmentDto {
  @ApiProperty({ example: 'Lapsed patients (90+ days)' })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ type: [SegmentRuleDto] })
  @ValidateNested({ each: true })
  @Type(() => SegmentRuleDto)
  @ArrayMaxSize(20)
  rules!: SegmentRuleDto[];

  @ApiProperty({ enum: ['ALL', 'ANY'] })
  @IsIn(['ALL', 'ANY'])
  match!: SegmentMatch;
}
