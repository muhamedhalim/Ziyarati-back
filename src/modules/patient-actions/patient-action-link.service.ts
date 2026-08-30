import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, createHash } from 'node:crypto';
import { Repository } from 'typeorm';

import { PatientActionLink } from '../../entities/Calendar&Appointments/PatientActionLink';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { PatientActionPurpose } from '../../entities/enums';
import { constantTimeEqual } from '../../common/utils/constant-time.util';

const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function digestOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Spec 014 (Clinic Platform Completion) — S1. Issues, resolves, consumes,
 * expires and invalidates `PatientActionLink` rows: the single credential
 * mechanism for every patient self-service action.
 */
@Injectable()
export class PatientActionLinkService {
  constructor(
    @InjectRepository(PatientActionLink)
    private readonly links: Repository<PatientActionLink>,
  ) {}

  /**
   * Issues a new link and returns the PLAINTEXT secret — the ONLY time it is
   * ever available; only its digest is persisted. Lifetime is capped at
   * min(7 days, appointment start) so a link can never outlive its own
   * appointment.
   *
   * `expiresAtOverride` (T158, US9) — for `WAITLIST_OFFER` links only: the
   * "min(7 days, appointment.start_at)" formula assumes the link's own
   * appointment is the thing it authorises an action on, which holds for
   * CANCEL/RESCHEDULE but not for a waitlist offer — at issue time there is
   * no prospective appointment yet (see `WaitlistOfferService`), and the
   * `appointment` this call still must pass (the column is NOT NULL) is the
   * ORIGINATING appointment whose cancellation/reschedule freed the slot,
   * whose own `start_at` has no bearing on how long the offer link should
   * stay resolvable. When provided, this replaces `appointment.start_at` in
   * the cap; the 7-day ceiling still applies either way.
   */
  async issue(
    tenantId: string,
    appointment: Appointment,
    purpose: PatientActionPurpose,
    waitlistOfferId?: string,
    expiresAtOverride?: Date,
  ): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    const maxLifetime = new Date(Date.now() + MAX_LIFETIME_MS);
    const naturalCap = expiresAtOverride ?? appointment.start_at;
    const expiresAt = naturalCap < maxLifetime ? naturalCap : maxLifetime;

    await this.links.save(
      this.links.create({
        tenant: { id: tenantId } as never,
        appointment: { id: appointment.id } as never,
        purpose,
        token_digest: digestOf(secret),
        expires_at: expiresAt,
        waitlist_offer: waitlistOfferId ?? null,
      }),
    );

    return secret;
  }

  /**
   * Resolves a presented secret to its link, or `null` for EVERY invalid
   * case (unknown digest, expired, already consumed) — deliberately
   * indistinguishable from one another so no response signal discloses
   * which condition applied. The digest itself scopes the row to exactly
   * one tenant/appointment; there is no cross-tenant ambiguity to resolve.
   *
   * The initial fetch is by indexed exact match on the digest (the same
   * pattern `RefreshToken`/`PasswordReset` already use); the digest is then
   * re-verified with `constantTimeEqual` before being treated as valid, so
   * the accept/reject decision is never made from a plain `===`.
   */
  async resolve(token: string): Promise<PatientActionLink | null> {
    const digest = digestOf(token);
    const candidate = await this.links.findOne({
      where: { token_digest: digest },
      // Eager-loads exactly what the public GET response (contracts/
      // public-surfaces.md §A) needs to display — one query, no second
      // fetch by every route that resolves a link (T031+).
      relations: {
        tenant: true,
        appointment: {
          branch: true,
          staff: { user: true },
          services: { service: true },
        },
      },
    });
    if (!candidate) return null;
    if (!constantTimeEqual(candidate.token_digest, digest)) return null;
    if (candidate.consumed_at) return null;
    if (candidate.expires_at.getTime() <= Date.now()) return null;
    return candidate;
  }

  /**
   * Consumes a link via a conditional UPDATE, so replay is a no-op
   * (FR-C004) rather than a race: two concurrent consumers can never both
   * succeed. Returns the number of rows actually updated (0 or 1).
   */
  async consume(id: string): Promise<number> {
    const result = await this.links
      .createQueryBuilder()
      .update(PatientActionLink)
      .set({ consumed_at: () => 'now()' })
      .where('id = :id AND consumed_at IS NULL', { id })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Invalidates every still-usable link for an appointment that has reached
   * a state where no patient action remains available (e.g. already
   * cancelled). Marks them consumed rather than deleting, so the row still
   * answers "what happened to this link" if ever inspected.
   */
  async invalidateFor(appointmentId: string): Promise<void> {
    await this.links
      .createQueryBuilder()
      .update(PatientActionLink)
      .set({ consumed_at: () => 'now()' })
      .where('"appointmentId" = :appointmentId AND consumed_at IS NULL', {
        appointmentId,
      })
      .execute();
  }
}
