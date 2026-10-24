import { AppError, ErrorCode } from '../../../common/errors';
import { isValidSendWindow, SendWindow } from './send-window.util';
import { ConditionKey, RuleLibraryDef } from './rule-library.catalog';

/**
 * Validates a library rule's settings. Typed, closed and bounded: a clinic picks
 * numbers from a form; nothing here is an expression and nothing is evaluated.
 * Unknown keys are refused (not silently dropped) so a typo cannot look saved.
 */
const RANGES: Record<Exclude<ConditionKey, 'sendWindow'>, [number, number]> = {
  inactivityDays: [30, 730],
  cooldownDays: [30, 365],
  dailyCap: [1, 1000],
};

export interface RuleConditions {
  sendWindow?: SendWindow;
  inactivityDays?: number;
  cooldownDays?: number;
  dailyCap?: number;
}

function bad(message: string, field: string): never {
  throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
    message,
    publicContext: { reason: 'INVALID_RULE_CONDITIONS', field },
  });
}

/** Defaults overlaid with what the clinic sent; throws on anything invalid. */
export function normalizeConditions(
  def: RuleLibraryDef,
  input: Record<string, unknown> | null | undefined,
): RuleConditions {
  const given = input ?? {};
  for (const key of Object.keys(given)) {
    if (!def.conditions.includes(key as ConditionKey)) {
      bad(`"${key}" is not a setting of this rule`, key);
    }
  }
  const merged: Record<string, unknown> = {
    ...def.defaultConditions,
    ...given,
  };

  for (const key of def.conditions) {
    const value = merged[key];
    if (key === 'sendWindow') {
      if (!isValidSendWindow(value)) {
        bad(
          'sendWindow needs whole hours: startHour 0–23 and endHour 1–24, with startHour before endHour',
          key,
        );
      }
      continue;
    }
    const [min, max] = RANGES[key];
    if (
      !Number.isInteger(value) ||
      (value as number) < min ||
      (value as number) > max
    ) {
      bad(`${key} must be a whole number from ${min} to ${max}`, key);
    }
  }
  return merged as RuleConditions;
}

/** Delay (minutes) within the rule's allowed range. */
export function assertDelay(def: RuleLibraryDef, delayMinutes: number): void {
  const [min, max] = def.delayRange;
  if (
    !Number.isInteger(delayMinutes) ||
    delayMinutes < min ||
    delayMinutes > max
  ) {
    bad(
      `delayMinutes must be a whole number from ${min} to ${max}`,
      'delayMinutes',
    );
  }
}
