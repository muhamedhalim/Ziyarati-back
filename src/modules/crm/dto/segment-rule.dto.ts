import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { SegmentField, SegmentOperator } from '../segment.constants';

/**
 * One condition in a `CustomerSegment.rules` array. `field`/`op` are the
 * closed vocabulary (R8) — `SegmentQueryBuilder` re-validates both are a
 * known member and that `op` is one this `field` actually supports; this DTO
 * only pins the TYPE (a real enum member, never an arbitrary string).
 */
export class SegmentRuleDto {
  @ApiProperty({ enum: SegmentField })
  @IsEnum(SegmentField)
  field!: SegmentField;

  @ApiProperty({ enum: SegmentOperator })
  @IsEnum(SegmentOperator)
  op!: SegmentOperator;

  @ApiProperty({
    description:
      'Bound as a query parameter, never as SQL text. Type depends on the field.',
    required: false,
  })
  @IsOptional()
  value?: string | number | boolean;
}
