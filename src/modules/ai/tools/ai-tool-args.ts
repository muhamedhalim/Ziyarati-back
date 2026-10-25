import { HttpException, type Logger } from '@nestjs/common';

import { AppError } from '../../../common/errors';
import { promptLine } from '../prompt/untrusted-text';
import type { ToolContext } from './ai-tool-dispatch.service';

/** The structured result handed back to the model as the `tool` message. */
export type ToolResult = Record<string, unknown>;

/** A non-blank string argument, else undefined. */
export function toolStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * A resource id the model proposed, accepted ONLY if it is a real UUID.
 *
 * Every public lookup casts its id to `uuid` in SQL, so a value that is not
 * one does not "find nothing" — it makes Postgres raise, and the driver's own
 * message (`invalid input syntax for type uuid: "..."`) came straight back as
 * the tool's error. Observed live: the model, handed a clinic named
 * `owner@inovra`, passed the NAME as `clinicId`; the model read the resulting
 * driver error as a platform fault, told the visitor the system had failed,
 * and escalated to a human — when all that had happened was a wrong argument
 * it could have corrected by re-reading the search result.
 *
 * Checking the shape first turns that into an ordinary, recoverable refusal
 * and keeps schema details out of the conversation.
 */
export function toolUuid(v: unknown): string | undefined {
  const s = toolStr(v)?.trim();
  return s &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ? s
    : undefined;
}

/** The refusal for a malformed id — names the recovery, leaks no schema. */
export function toolBadId(field: string, source: string): ToolResult {
  return {
    success: false,
    error: `${field} must be the UUID exactly as returned by ${source} — not a name, and not a value you composed. Re-read it from that result and try again.`,
  };
}

/**
 * The error text handed back to the MODEL, which may repeat it to the person.
 *
 * An `AppError` / `HttpException` message is written for a caller and is safe
 * to show. Anything else is an unexpected failure — a driver error naming a
 * column or constraint, a TypeError with an internal path — and is logged here
 * and replaced with a fixed line, so internals never enter the conversation.
 */
export function toolErrorMessage(err: unknown, logger: Logger): string {
  if (err instanceof AppError || err instanceof HttpException) {
    return err.message;
  }
  logger.warn(
    `tool failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
  );
  return 'Tool execution failed.';
}

/**
 * AI-017 (FR-033, FR-034): the acting STAFF principal, explicit null for
 * guests — never a guest's own principal id. `ctx.actorUserId` alone is
 * not sufficient (a guest turn's `ToolContext` can carry `actorUserId`
 * too, from `this.ctx.getUser()?.id` upstream in `ai-execution.service.ts`
 * without a guest check — that field means something different there:
 * "is a real user bound to this conversation," which is separately true
 * or false for guests). `ctx.principal?.guest` is the authoritative
 * signal.
 */
export function toolActorUserId(ctx: ToolContext): string | null {
  if (ctx.principal?.guest) return null;
  return ctx.actorUserId ?? null;
}

/**
 * Is this turn a public guest (or otherwise has no acting user)?
 *
 * `!ctx.actorUserId` alone answers a different question. `AiExecutionService`
 * fills `actorUserId` from `getUser().id`, and a guest principal's id is
 * its session subject — so for every guest turn `actorUserId` is set, the
 * "no acting user" gates never fired, and the guest branches of
 * `get_branch_info` / `get_doctor_schedule` / availability were unreachable
 * from the real widget (F-01). `principal.guest` is the authoritative signal;
 * a missing `actorUserId` is kept as guest too, so no turn that has no user
 * at all is ever treated as authenticated.
 */
export function toolIsGuest(ctx: ToolContext): boolean {
  return !ctx.actorUserId || ctx.principal?.guest === true;
}

/**
 * Clinic-owned text (a branch, service or doctor name) placed in a SYSTEM
 * message: collapsed to one short line so a name can neither break the block's
 * structure nor carry a paragraph of instructions into it.
 */
export function toolOneLine(text: string | null | undefined): string {
  return promptLine(text, 60);
}

/** 'HH:MM' of an ISO instant in `zone` — what the patient is actually told. */
export function toolLocalHhmm(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}
