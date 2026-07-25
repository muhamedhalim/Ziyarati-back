import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';

import { IntegrationStaffProvisioning } from '../../../entities/Integration/IntegrationStaffProvisioning';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { StaffProfile } from '../../../entities/Staff/StaffProfile';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { User } from '../../../entities/Auth&RBAC/User';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';

import { StaffService as StaffDomainService } from '../../staff/staff.service';
import { StaffAccessService } from '../../staff/staff-access.service';
import { RolesService } from '../../auth/roles.service';
import { CreateStaffWithNewUserDto } from '../../staff/dto/create-staff-with-new-user.dto';

import {
  INTEGRATION_RESOURCE,
  MAPPING_SOURCE,
  STAFF_PROVISIONING_STATUS,
  OPEN_PROVISIONING_STATUSES,
} from '../integration-platform.constants';
import { IntegrationIdMapService } from '../mappings/integration-id-map.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';
import {
  ApproveStaffProvisioningDto,
  LinkStaffProvisioningDto,
  QueryStaffProvisioningDto,
  RejectStaffProvisioningDto,
} from '../dto/staff-provisioning.dto';

interface Actor {
  userId?: string;
  ip?: string;
}

export interface RecordProvisioningInput {
  tenantId: string;
  connectionId: string;
  externalId: string;
  fullName?: string | null;
  email?: string | null;
  profile: Record<string, unknown>;
  candidateStaffIds?: string[];
}

/**
 * Staff provisioning review queue (Phase 4).
 *
 * THE PROBLEM. `staff_profiles.user_id` is a required 1:1 to `users`, so
 * importing a new staff member necessarily means creating a login identity,
 * assigning it a role, and consuming a plan seat. That is a privileged decision
 * about who may sign in to a clinic. An external PMS must not make it — but
 * failing every new-staff import outright would make staff sync useless.
 *
 * THE RESOLUTION. An import records a REVIEWABLE REQUEST here. A tenant admin
 * approves it and CHOOSES the role; approval then runs the platform's existing
 * provisioning + invitation flow. Concretely:
 *
 *  - `StaffService.createWithNewUser` creates the user + profile inside its own
 *    transaction, with the role resolved through `RolesService`
 *    .findAssignableRoleBySlug — which already refuses owner/super-admin and any
 *    other non-staff role, so a privileged role can never be granted this way.
 *  - The temporary password that method returns is DISCARDED here and never
 *    persisted, logged, or returned. The member receives a single-use
 *    set-password invitation instead (`StaffAccessService.resendInvitation`),
 *    which is the platform's normal, secure onboarding path.
 *
 * There is no second authentication flow: this service issues no credential and
 * validates none.
 *
 * IDEMPOTENCY. One open request per (tenant, connection, external id), enforced
 * by a partial unique index, so a repeated import updates the pending request
 * rather than queuing duplicates or creating two accounts for one person.
 */
@Injectable()
export class IntegrationStaffProvisioningService {
  private readonly logger = new Logger(IntegrationStaffProvisioningService.name);

  constructor(
    @InjectRepository(IntegrationStaffProvisioning)
    private readonly repo: Repository<IntegrationStaffProvisioning>,
    @InjectRepository(StaffProfile)
    private readonly staffRepo: Repository<StaffProfile>,
    private readonly staff: StaffDomainService,
    private readonly staffAccess: StaffAccessService,
    private readonly roles: RolesService,
    private readonly idMap: IntegrationIdMapService,
    private readonly audit: IntegrationAuditService,
  ) {}

  /**
   * Record (or refresh) a provisioning request from the import pipeline.
   * Best-effort by design — it accompanies a conflict that has already been
   * persisted, so a failure here must never break the import that raised it.
   */
  async record(input: RecordProvisioningInput): Promise<IntegrationStaffProvisioning | null> {
    const candidates = input.candidateStaffIds ?? [];
    const status =
      candidates.length > 1 ? STAFF_PROVISIONING_STATUS.AMBIGUOUS : STAFF_PROVISIONING_STATUS.PENDING;

    try {
      const existing = await this.repo.findOne({
        where: {
          tenant: { id: input.tenantId },
          connection: { id: input.connectionId },
          external_id: input.externalId,
          status: In(OPEN_PROVISIONING_STATUSES),
        },
      });

      if (existing) {
        existing.proposed_full_name = input.fullName ?? existing.proposed_full_name ?? null;
        existing.proposed_email = normalizeEmail(input.email) ?? existing.proposed_email ?? null;
        existing.proposed_profile = input.profile;
        existing.candidate_staff_ids = candidates;
        existing.status = status;
        return await this.repo.save(existing);
      }

      return await this.repo.save(
        this.repo.create({
          tenant: { id: input.tenantId } as Tenant,
          connection: { id: input.connectionId } as IntegrationConnection,
          external_id: input.externalId,
          status,
          proposed_full_name: input.fullName ?? null,
          proposed_email: normalizeEmail(input.email) ?? null,
          proposed_profile: input.profile,
          candidate_staff_ids: candidates,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) return null; // concurrent import won the race
      this.logger.warn(`staff provisioning record failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  async list(tenantId: string, query: QueryStaffProvisioningDto) {
    const where: FindOptionsWhere<IntegrationStaffProvisioning> = { tenant: { id: tenantId } };
    if (query.connectionId) where.connection = { id: query.connectionId };
    const status = query.status ?? 'open';
    where.status = status === 'open' ? In(OPEN_PROVISIONING_STATUSES) : status;

    const [rows, total] = await this.repo.findAndCount({
      where,
      relations: { connection: true, staff_profile: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data: rows.map((r) => this.toView(r)), total, page: query.page, limit: query.limit };
  }

  /**
   * APPROVE — provision the account through the verified domain flow, then send
   * the standard set-password invitation. The temporary password produced by
   * the domain service is deliberately discarded.
   */
  async approve(
    tenantId: string,
    id: string,
    dto: ApproveStaffProvisioningDto,
    actor: Actor,
  ) {
    const req = await this.getOpenOrThrow(tenantId, id);

    const email = normalizeEmail(dto.email ?? req.proposed_email);
    if (!email) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'An email address is required to provision a staff account',
      });
    }
    const fullName = (dto.fullName ?? req.proposed_full_name ?? '').trim();
    if (!fullName) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'A full name is required to provision a staff account',
      });
    }

    // EXPLICIT ROLE POLICY: the approver must name the role, and it is validated
    // against the tenant's assignable-role catalogue — which already refuses
    // owner/super-admin and other non-staff roles. There is no implicit default,
    // so nobody is silently granted more than intended.
    if (!dto.roleSlug) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Select the role this staff member should be given',
      });
    }
    await this.roles.findAssignableRoleBySlug(dto.roleSlug, tenantId);

    // Only allowlisted PROFILE fields are carried over from the external system.
    const profile = (req.proposed_profile ?? {}) as Record<string, unknown>;

    let created: { profile: StaffProfile };
    try {
      created = await this.staff.createWithNewUser(tenantId, {
        email,
        fullName,
        roleSlug: dto.roleSlug,
        title: asString(profile.title),
        bio: asString(profile.bio),
        bookingBufferMinutes: asNumber(profile.bookingBufferMinutes),
        isAvailableForBooking: asBoolean(profile.isAvailableForBooking),
        branchIds: dto.branchIds,
        primaryBranchId: dto.primaryBranchId,
      } as CreateStaffWithNewUserDto);
      // The temporary password returned above is intentionally NOT destructured,
      // stored, logged, or returned — the member sets their own via invitation.
    } catch (err) {
      // A taken email means a real account already exists: linking is the safe
      // resolution, never overwriting or duplicating that person.
      if (err instanceof AppError && err.code === ErrorCode.EMAIL_ALREADY_EXISTS) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'An account already exists with this email — link this external record to that staff member instead of creating a second account',
        });
      }
      throw err;
    }

    const staffId = created.profile.id;

    // Map the external record to the new profile so the next import updates it
    // instead of queueing another provisioning request.
    await this.idMap
      .link(
        tenantId,
        req.connection?.id as string,
        INTEGRATION_RESOURCE.STAFF,
        req.external_id,
        staffId,
        MAPPING_SOURCE.EXTERNAL,
      )
      .catch((e) => this.logger.warn(`staff mapping link after provisioning failed: ${(e as Error)?.message}`));

    // Standard secure onboarding: a single-use set-password invitation.
    let invitationSent = false;
    try {
      await this.staffAccess.resendInvitation(tenantId, staffId, actor.userId as string, actor.ip);
      invitationSent = true;
    } catch (e) {
      // Provisioning already succeeded; a mail/role-state hiccup must not undo
      // it. The admin can resend from the staff page.
      this.logger.warn(`invitation after provisioning failed: ${(e as Error)?.message}`);
    }

    req.status = STAFF_PROVISIONING_STATUS.APPROVED;
    req.approved_role_slug = dto.roleSlug;
    req.staff_profile = { id: staffId } as StaffProfile;
    req.created_user = created.profile.user ? ({ id: created.profile.user.id } as User) : null;
    req.reviewed_by = actor.userId ? ({ id: actor.userId } as User) : null;
    req.reviewed_at = new Date();
    req.invitation_sent = invitationSent;
    req.invitation_sent_at = invitationSent ? new Date() : null;
    const saved = await this.repo.save(req);

    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.STAFF_PROVISION_APPROVE,
      tenantId,
      INTEGRATION_RESOURCE.STAFF,
      staffId,
      actor,
      {
        provisioningId: id,
        connectionId: req.connection?.id ?? null,
        externalId: req.external_id,
        roleSlug: dto.roleSlug,
        invitationSent,
      },
    );
    return this.toView(saved);
  }

  /**
   * LINK — resolve the request against an EXISTING staff member instead of
   * creating an account. This is the correct outcome for an ambiguous match and
   * for anyone who already has a profile: it only creates a mapping and never
   * touches the user, its roles, its access state, or any money/reputation field.
   */
  async link(tenantId: string, id: string, dto: LinkStaffProvisioningDto, actor: Actor) {
    const req = await this.getOpenOrThrow(tenantId, id);

    const staff = await this.staffRepo.findOne({
      where: { id: dto.staffId, tenant: { id: tenantId } },
    });
    if (!staff) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found in this clinic' });
    }

    // The mapping service refuses an inconsistent remap (409) rather than
    // silently repointing an existing correspondence.
    await this.idMap.link(
      tenantId,
      req.connection?.id as string,
      INTEGRATION_RESOURCE.STAFF,
      req.external_id,
      staff.id,
      MAPPING_SOURCE.PLATFORM,
    );

    req.status = STAFF_PROVISIONING_STATUS.LINKED;
    req.staff_profile = { id: staff.id } as StaffProfile;
    req.reviewed_by = actor.userId ? ({ id: actor.userId } as User) : null;
    req.reviewed_at = new Date();
    const saved = await this.repo.save(req);

    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.STAFF_PROVISION_LINK,
      tenantId,
      INTEGRATION_RESOURCE.STAFF,
      staff.id,
      actor,
      { provisioningId: id, connectionId: req.connection?.id ?? null, externalId: req.external_id },
    );
    return this.toView(saved);
  }

  /** REJECT — no account is created and no mapping is made. */
  async reject(tenantId: string, id: string, dto: RejectStaffProvisioningDto, actor: Actor) {
    const req = await this.getOpenOrThrow(tenantId, id);
    req.status = STAFF_PROVISIONING_STATUS.REJECTED;
    req.note = dto.reason ? dto.reason.slice(0, 500) : null;
    req.reviewed_by = actor.userId ? ({ id: actor.userId } as User) : null;
    req.reviewed_at = new Date();
    const saved = await this.repo.save(req);

    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.STAFF_PROVISION_REJECT,
      tenantId,
      INTEGRATION_RESOURCE.STAFF,
      id,
      actor,
      { connectionId: req.connection?.id ?? null, externalId: req.external_id },
    );
    return this.toView(saved);
  }

  /** Re-send the set-password invitation for an approved request. */
  async resendInvitation(tenantId: string, id: string, actor: Actor) {
    const req = await this.repo.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { connection: true, staff_profile: true },
    });
    if (!req) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Provisioning request not found' });
    if (req.status !== STAFF_PROVISIONING_STATUS.APPROVED || !req.staff_profile?.id) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Only an approved request with a provisioned account can be re-invited',
      });
    }
    // Delegates to the platform's own invitation flow — including its guard that
    // someone who has already signed in must use "forgot password" instead.
    await this.staffAccess.resendInvitation(tenantId, req.staff_profile.id, actor.userId as string, actor.ip);
    req.invitation_sent = true;
    req.invitation_sent_at = new Date();
    return this.toView(await this.repo.save(req));
  }

  private async getOpenOrThrow(tenantId: string, id: string): Promise<IntegrationStaffProvisioning> {
    const req = await this.repo.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { connection: true, staff_profile: true },
    });
    if (!req) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Provisioning request not found' });
    if (!OPEN_PROVISIONING_STATUSES.includes(req.status as never)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This provisioning request has already been reviewed',
      });
    }
    if (!req.connection?.id) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The connection for this request was removed',
      });
    }
    return req;
  }

  /** Safe projection — never a credential, role grant, or protected field. */
  private toView(r: IntegrationStaffProvisioning) {
    return {
      id: r.id,
      connectionId: r.connection?.id ?? null,
      externalId: r.external_id,
      status: r.status,
      proposedFullName: r.proposed_full_name ?? null,
      proposedEmail: r.proposed_email ?? null,
      proposedProfile: r.proposed_profile ?? {},
      candidateStaffIds: r.candidate_staff_ids ?? [],
      isAmbiguous: r.status === STAFF_PROVISIONING_STATUS.AMBIGUOUS,
      approvedRoleSlug: r.approved_role_slug ?? null,
      staffProfileId: r.staff_profile?.id ?? null,
      invitationSent: r.invitation_sent,
      invitationSentAt: r.invitation_sent_at ?? null,
      note: r.note ?? null,
      reviewedBy: r.reviewed_by?.id ?? null,
      reviewedAt: r.reviewed_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

function normalizeEmail(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
