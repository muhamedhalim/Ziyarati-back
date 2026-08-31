import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  ACTIVITY_SEARCH_MIN_LENGTH,
  ACTIVITY_SUGGESTION_LIMIT,
} from '../activity-log.constants';

/**
 * `GET /activity/suggestions`'s query params. Deliberately tiny — a typeahead
 * request carries a term and nothing else, and is bounded server-side to this
 * tenant's allow-listed activity exactly like `GET /activity` is.
 */
export class QueryActivitySuggestionsDto {
  @ApiPropertyOptional({
    description:
      `Partial term (min ${ACTIVITY_SEARCH_MIN_LENGTH} characters after trimming; ` +
      'anything shorter returns an empty list rather than an error). Matched ' +
      'case-insensitively against actor names/emails, action names and entity labels.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ACTIVITY_SUGGESTION_LIMIT,
    default: ACTIVITY_SUGGESTION_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ACTIVITY_SUGGESTION_LIMIT)
  limit: number = ACTIVITY_SUGGESTION_LIMIT;
}
