import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationPreference } from '../../../entities/Notifications/NotificationPreference';
import { User } from '../../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../../common/errors';

import {
  isCategoryMutable,
  mutableCategories,
  NOTIFICATION_CATALOG,
  NOTIFICATION_KEYS,
} from './notification-catalog';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from './notification-keys';
import type { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

export interface PreferenceView {
  category: NotificationCategory;
  muted: boolean;
  /**
   * `false` when every notification in the category is mandatory. The UI should
   * render such a category as an explanation, not a disabled switch that looks
   * like it might work.
   */
  mutable: boolean;
  /** Catalog keys in this category — lets the UI say what muting would cost. */
  keys: string[];
}

/**
 * The caller's own notification preferences.
 *
 * DEFAULT IS ALWAYS "DELIVER". Absence of a row means not muted, so a user who
 * has never opened this screen receives everything and no backfill or seeding
 * is required. Only active mutes are stored.
 *
 * MANDATORY CATEGORIES CANNOT BE MUTED, and that is enforced TWICE — here, when
 * a mute is written, and again in `InternalNotificationService.emit`, which
 * skips the preference lookup entirely for a mandatory spec. Two independent
 * points because a single one is a single point of failure for what is, for
 * SECURITY notifications, a security control: a `muted` row inserted straight
 * into the database still cannot suppress a password-change or session-reuse
 * alert.
 */
@Injectable()
export class InternalNotificationPreferenceService {
  constructor(
    @InjectRepository(NotificationPreference)
    private readonly preferences: Repository<NotificationPreference>,
  ) {}

  /**
   * Every category with the caller's current setting.
   *
   * Returns the full list, not just stored rows, so the UI can render the whole
   * screen from one response without knowing the catalog itself.
   */
  async list(userId: string): Promise<PreferenceView[]> {
    const stored = await this.preferences.find({
      where: { user: { id: userId } },
      relations: { user: true },
    });
    const mutedByCategory = new Map(
      stored.map((row) => [row.category, row.muted]),
    );

    return NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      muted: mutedByCategory.get(category) ?? false,
      mutable: isCategoryMutable(category),
      keys: NOTIFICATION_KEYS.filter(
        (key) => NOTIFICATION_CATALOG[key].category === category,
      ),
    }));
  }

  /**
   * Applies the caller's changes.
   *
   * Rejects the whole payload if it tries to mute an unmutable category — a
   * partial apply would leave the user believing a setting took effect when it
   * silently did not. Unmuting is always allowed, including for a category that
   * is not mutable, so a row written before a catalog change can always be
   * cleared.
   */
  async update(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<PreferenceView[]> {
    const refused = dto.preferences.filter(
      (p) => p.muted && !isCategoryMutable(p.category as NotificationCategory),
    );
    if (refused.length > 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          `These notifications are required and cannot be turned off: ` +
          `${refused.map((p) => p.category).join(', ')}.`,
        publicContext: {
          refused: refused.map((p) => p.category),
          mutable: mutableCategories(),
        },
      });
    }

    for (const item of dto.preferences) {
      // Upsert on the unique (user_id, category) index rather than
      // read-then-write: two tabs toggling the same category race harmlessly
      // instead of one of them raising 23505.
      await this.preferences
        .createQueryBuilder()
        .insert()
        .into(NotificationPreference)
        .values({
          user: { id: userId } as User,
          category: item.category,
          muted: item.muted,
        })
        .orUpdate(['muted', 'updated_at'], [
          'user_id',
          'category',
        ])
        .execute();
    }

    return this.list(userId);
  }
}
