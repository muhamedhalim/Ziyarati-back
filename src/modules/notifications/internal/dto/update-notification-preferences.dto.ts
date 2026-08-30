import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { NOTIFICATION_CATEGORIES } from '../notification-keys';

export class NotificationPreferenceItemDto {
  @ApiProperty({
    description: 'The category this preference applies to.',
    enum: NOTIFICATION_CATEGORIES,
    example: 'APPOINTMENTS',
  })
  @IsIn(NOTIFICATION_CATEGORIES)
  category!: string;

  @ApiProperty({
    description:
      'true = stop delivering this category. Rejected for a category in which every ' +
      'notification is mandatory (e.g. SECURITY) — the API refuses rather than storing a ' +
      'preference the emit path would ignore.',
    example: true,
  })
  @IsBoolean()
  muted!: boolean;
}

/**
 * Replaces the caller's own preferences for the categories named.
 *
 * There is no `userId` — preferences are always the caller's own, for the same
 * reason the inbox filter has no `recipientId`.
 *
 * Categories omitted from the payload are left untouched, so a client can send
 * a single toggle without having to round-trip the full set and risk clobbering
 * a change made in another tab.
 */
export class UpdateNotificationPreferencesDto {
  @ApiProperty({
    description: 'The preferences to set. Omitted categories are left unchanged.',
    type: [NotificationPreferenceItemDto],
  })
  @IsArray()
  // One entry per category is the most that can ever be meaningful; the cap
  // stops a payload of thousands of duplicate rows from being processed.
  @ArrayMaxSize(NOTIFICATION_CATEGORIES.length)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceItemDto)
  preferences!: NotificationPreferenceItemDto[];
}
