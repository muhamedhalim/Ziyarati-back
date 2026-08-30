import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_LOCALES,
  NOTIFICATION_PRIORITIES,
} from '../notification-keys';

/** `unread` is the badge-driven default view; `all` includes read history. */
export const INBOX_STATUSES = ['all', 'unread'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/**
 * Filter + pagination for the caller's OWN inbox.
 *
 * There is deliberately no `recipientId` and no `userId` field. The recipient
 * is always taken from the authenticated principal, so a caller has no way to
 * ask for anyone else's notifications — the IDOR is prevented by the shape of
 * the contract rather than by a check that could be forgotten. (Contrast
 * `NotificationLogFilterDto`, which accepts `recipientId` because it addresses
 * patients within an already tenant-scoped, permission-gated resource.)
 */
export class InboxFilterDto {
  @ApiPropertyOptional({
    description: 'Which notifications to return. Defaults to unread only.',
    enum: INBOX_STATUSES,
    default: 'unread',
  })
  @IsOptional()
  @IsIn(INBOX_STATUSES)
  status: InboxStatus = 'unread';

  @ApiPropertyOptional({
    description: 'Restrict to one category.',
    enum: NOTIFICATION_CATEGORIES,
    example: 'SUPPORT',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({
    description: 'Restrict to one priority.',
    enum: NOTIFICATION_PRIORITIES,
    example: 'HIGH',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional({
    description:
      'Language to render title/body in. Defaults to the caller\'s stored preferred_locale, then English. ' +
      'Pass the active UI locale so notifications follow a language switch immediately.',
    enum: NOTIFICATION_LOCALES,
    example: 'ar',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_LOCALES)
  locale?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 50.', example: 20, minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}
