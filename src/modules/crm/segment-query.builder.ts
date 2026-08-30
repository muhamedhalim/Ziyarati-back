import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../common/errors';
import {
  SegmentField,
  SegmentOperator,
  SegmentRule,
  SegmentMatch,
  SEGMENT_FIELD_OPERATORS,
} from './segment.constants';

export interface CompiledSegmentQuery {
  /** A tenant + soft-delete + rules WHERE fragment — never a full statement. */
  whereSql: string;
  /** Positional values — `whereSql` references them as `$1, $2, ...`, matching `dataSource.query`'s convention. `values[0]` is always `tenantId`. */
  values: unknown[];
}

/**
 * Spec 014 (Clinic Platform Completion) — Phase 10 (US8, FR-S002, R8).
 *
 * Compiles a closed rule vocabulary into ONE parameterised WHERE fragment
 * against `customers c` (raw SQL, in the same style as
 * `ClinicalTimelineService`'s UNION query — a plain `dataSource.query` call
 * is easier to reason about and test here than TypeORM's QueryBuilder for a
 * dynamic AND/OR tree with EXISTS subqueries). `field` is always resolved
 * through the switch below — an enum member, never a caller-supplied column
 * or table identifier — so no rule can reach the query as raw SQL text.
 * `value` only ever becomes a bound parameter, never string-concatenated.
 */
@Injectable()
export class SegmentQueryBuilder {
  build(
    tenantId: string,
    rules: SegmentRule[],
    match: SegmentMatch,
  ): CompiledSegmentQuery {
    const values: unknown[] = [tenantId];
    const base = 'c."tenantId" = $1 AND c.deleted_at IS NULL';

    if (rules.length === 0) return { whereSql: base, values };

    const fragments = rules.map((rule) => this.compileRule(rule, values));
    const joiner = match === 'ANY' ? ' OR ' : ' AND ';
    return { whereSql: `${base} AND (${fragments.join(joiner)})`, values };
  }

  /** Appends any bound values to `values` and returns the SQL fragment referencing them by position. */
  private compileRule(rule: SegmentRule, values: unknown[]): string {
    const allowedOps = SEGMENT_FIELD_OPERATORS[rule.field];
    if (!allowedOps) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Unknown segment field "${String(rule.field)}"`,
      });
    }
    if (!allowedOps.includes(rule.op)) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Operator "${rule.op}" is not supported for field "${rule.field}"`,
      });
    }

    const tenantPos = 1; // $1 is always the tenant id, set by build()/buildPositional()
    const push = (v: unknown): number => {
      values.push(v);
      return values.length;
    };

    switch (rule.field) {
      case SegmentField.MARKETING_CONSENT: {
        const pos = push(rule.op === SegmentOperator.IS_TRUE);
        return `c.marketing_opt_in = $${pos}`;
      }

      case SegmentField.MESSAGING_OPTED_OUT:
        return rule.op === SegmentOperator.IS_TRUE
          ? 'c.opted_out_at IS NOT NULL'
          : 'c.opted_out_at IS NULL';

      case SegmentField.CUSTOMER_ACTIVE: {
        const pos = push(rule.op === SegmentOperator.IS_TRUE);
        return `c.is_active = $${pos}`;
      }

      case SegmentField.CUSTOMER_CREATED_AT: {
        const pos = push(rule.value);
        return `c.created_at ${rule.op === SegmentOperator.AFTER ? '>' : '<'} $${pos}`;
      }

      case SegmentField.BIRTH_DATE_IN_PERIOD: {
        const pos = push(Number(rule.value ?? 0));
        return `c.date_of_birth IS NOT NULL AND (
          (DATE_PART('doy', c.date_of_birth::date) - DATE_PART('doy', CURRENT_DATE) + 366) % 366
        ) <= $${pos}`;
      }

      case SegmentField.CUSTOMER_TAG: {
        const pos = push(rule.value);
        return `EXISTS (
          SELECT 1 FROM customer_tag_relations ctr
          WHERE ctr."customerId" = c.id AND ctr."tagId" = $${pos}
        )`;
      }

      case SegmentField.LAST_APPOINTMENT_AT: {
        const pos = push(rule.value);
        return `EXISTS (
          SELECT 1 FROM appointments a
          WHERE a."customerId" = c.id AND a."tenantId" = $${tenantPos}
          GROUP BY a."customerId"
          HAVING MAX(a.start_at) ${rule.op === SegmentOperator.AFTER ? '>' : '<'} $${pos}
        )`;
      }

      case SegmentField.APPOINTMENT_COUNT: {
        const cmp =
          rule.op === SegmentOperator.GREATER_THAN
            ? '>'
            : rule.op === SegmentOperator.LESS_THAN
              ? '<'
              : '=';
        const pos = push(rule.value);
        return `(
          SELECT COUNT(*) FROM appointments a
          WHERE a."customerId" = c.id AND a."tenantId" = $${tenantPos}
        ) ${cmp} $${pos}`;
      }

      case SegmentField.APPOINTMENT_STATUS: {
        const pos = push(rule.value);
        return `EXISTS (
          SELECT 1 FROM appointments a
          WHERE a."customerId" = c.id AND a."tenantId" = $${tenantPos} AND a.status = $${pos}
        )`;
      }

      case SegmentField.SERVICE_BOOKED: {
        const pos = push(rule.value);
        return `EXISTS (
          SELECT 1 FROM appointment_services aps
          JOIN appointments a ON a.id = aps."appointmentId"
          WHERE a."customerId" = c.id AND aps."tenantId" = $${tenantPos} AND aps."serviceId" = $${pos}
        )`;
      }

      case SegmentField.BRANCH_ATTENDED: {
        const pos = push(rule.value);
        return `EXISTS (
          SELECT 1 FROM appointments a
          WHERE a."customerId" = c.id AND a."tenantId" = $${tenantPos} AND a."branchId" = $${pos}
        )`;
      }

      default:
        throw new AppError(ErrorCode.BAD_REQUEST, {
          message: `Unknown segment field "${String(rule.field)}"`,
        });
    }
  }
}
