import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** `YYYY-MM`, month 01-12. The only shape a billing period may take. */
export const PERIOD_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriodMonth(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_MONTH_RE.test(value);
}

/**
 * Validates an optional `periodMonth` query value before it reaches a service.
 * The usage queries build SQL around the period, so anything that is not a plain
 * `YYYY-MM` must be refused at the edge (CR-36).
 */
@Injectable()
export class PeriodMonthPipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (!isPeriodMonth(value)) {
      throw new BadRequestException('periodMonth must be YYYY-MM');
    }
    return value;
  }
}
