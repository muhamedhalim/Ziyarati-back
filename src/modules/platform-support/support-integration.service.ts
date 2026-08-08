import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { MerchantAccount } from '../../entities/Payments/MerchantAccount';
import { TenantAiDeployment } from '../../entities/AI Agent/TenantAiDeployment';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { StorageService } from '../storage/storage.service';

import { SupportClinicResolver } from './support-clinic.resolver';
import { isoOrNull, sanitizeFailureReason } from './support-privacy.util';

/**
 * Health of a single integration, as Support reads it.
 *
 * The four states are deliberately distinct — collapsing them is the single
 * most common way an integration status view becomes useless:
 *   `not_configured` — the clinic never connected it. Nothing is broken.
 *   `configured`     — connected, and nothing suggests a problem.
 *   `degraded`       — connected, but recent activity shows failures.
 *   `disconnected`   — was connected, and the provider/operator has since
 *                      turned it off or revoked it.
 */
export type IntegrationHealth =
  | 'not_configured'
  | 'configured'
  | 'degraded'
  | 'disconnected';

/**
 * Unified integration status for one clinic.
 *
 * SECRETS. Every one of these integrations stores a credential on the very row
 * this service reads — `whatsapp_accounts.access_token` (encrypted),
 * `tenant_ai_deployments.api_key_ciphertext`, merchant bank details. None is
 * ever selected: each query names its columns explicitly, so a credential
 * cannot reach a response even by accident. Where a credential's PRESENCE is
 * diagnostically relevant ("is a token attached at all?"), a boolean is
 * derived in SQL and the value itself never leaves the database.
 *
 * The response reports STATUS ONLY — no tokens, no app secrets, no webhook
 * verification secrets, no full provider payloads.
 */
@Injectable()
export class SupportIntegrationService {
  constructor(
    private readonly clinics: SupportClinicResolver,
    @InjectRepository(WhatsappAccount)
    private readonly whatsappAccounts: Repository<WhatsappAccount>,
    @InjectRepository(MerchantAccount)
    private readonly merchants: Repository<MerchantAccount>,
    @InjectRepository(TenantSetting)
    private readonly settings: Repository<TenantSetting>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  async overview(tenantId: string) {
    await this.clinics.assertExists(tenantId);

    const [whatsapp, email, payments, ai, storage] = await Promise.all([
      this.whatsapp(tenantId),
      this.email(tenantId),
      this.payments(tenantId),
      this.ai(tenantId),
      Promise.resolve(this.storageStatus()),
    ]);

    return {
      whatsapp,
      email,
      payments,
      ai,
      storage,
      checkedAt: new Date().toISOString(),
    };
  }

  // ── WhatsApp / Meta ──────────────────────────────────────────────────────

  /**
   * Connection + traffic health for the clinic's own WABA.
   *
   * `access_token` is NOT in the select list. `hasCredentials` is computed in
   * SQL (`access_token IS NOT NULL`) so the ciphertext is never materialised
   * in the application at all — matching how the WhatsApp module's own read
   * APIs already expose this.
   */
  async whatsapp(tenantId: string) {
    const accounts: WhatsappAccountRow[] = await this.dataSource.query(
      `
      SELECT wa.id,
             wa.display_phone_number,
             wa.verified_name,
             wa.waba_id,
             wa.meta_business_id,
             wa.connection_status,
             wa.is_active,
             wa.is_default,
             wa.connected_at,
             wa.last_synced_at,
             wa.token_expires_at,
             (wa.access_token IS NOT NULL) AS has_credentials
        FROM whatsapp_accounts wa
       WHERE wa."tenantId" = $1 AND wa.deleted_at IS NULL
       ORDER BY wa.is_default DESC, wa.created_at ASC
      `,
      [tenantId],
    );

    if (accounts.length === 0) {
      return {
        health: 'not_configured' as IntegrationHealth,
        accounts: [],
        webhook: await this.whatsappWebhookHealth(tenantId),
        traffic: await this.whatsappTraffic(tenantId),
      };
    }

    const anyLive = accounts.some(
      (a) => a.is_active && a.connection_status === 'CONNECTED',
    );
    const traffic = await this.whatsappTraffic(tenantId);
    const webhook = await this.whatsappWebhookHealth(tenantId);

    let health: IntegrationHealth = anyLive ? 'configured' : 'disconnected';
    if (anyLive && traffic.failedLast7Days > 0) health = 'degraded';

    return {
      health,
      accounts: accounts.map((a) => ({
        id: a.id,
        displayPhoneNumber: a.display_phone_number ?? null,
        verifiedName: a.verified_name ?? null,
        wabaId: a.waba_id ?? null,
        metaBusinessId: a.meta_business_id ?? null,
        connectionStatus: a.connection_status,
        isActive: a.is_active,
        isDefault: a.is_default,
        /** Presence only — the token itself is never read out of the database. */
        hasCredentials: a.has_credentials,
        connectedAt: isoOrNull(a.connected_at),
        lastSyncedAt: isoOrNull(a.last_synced_at),
        tokenExpiresAt: isoOrNull(a.token_expires_at),
      })),
      webhook,
      traffic,
    };
  }

  /**
   * The FOCUSED WhatsApp view, gated by its own
   * `platform.support.whatsapp.read_diagnostics` slug rather than the broad
   * integrations read — a clinic's messaging state is more sensitive than a
   * configured/not-configured roll-up, so it is a separate grant.
   *
   * Adds, on top of `whatsapp()`: recent per-message failures (sanitized) and
   * template approval state, the two things a "messages stopped working"
   * ticket resolves to in practice — a revoked token, or a template Meta
   * rejected.
   *
   * Still never returned: the Meta access token, app secret, webhook
   * verification secret, or any webhook payload containing message content.
   */
  async whatsappDiagnostics(tenantId: string) {
    await this.clinics.assertExists(tenantId);

    const [base, failures, templates] = await Promise.all([
      this.whatsapp(tenantId),
      this.recentWhatsappFailures(tenantId),
      this.whatsappTemplateStatus(tenantId),
    ]);

    return { ...base, recentFailures: failures, templates };
  }

  /**
   * The last few failed WhatsApp sends, reduced to a sanitized reason and a
   * timestamp. No recipient, no message body, no provider payload — a support
   * agent needs the failure CATEGORY ("token expired", "template paused"), and
   * the per-recipient view already exists (masked) under notification history.
   */
  private async recentWhatsappFailures(tenantId: string) {
    const rows = await this.dataSource.query(
      `
      SELECT created_at, error_message
        FROM notification_logs
       WHERE "tenantId" = $1 AND channel = 'WHATSAPP' AND status = 'FAILED'
         AND error_message IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 10
      `,
      [tenantId],
    );
    return rows.map((r: { created_at: Date; error_message: string }) => ({
      at: isoOrNull(r.created_at),
      reason: sanitizeFailureReason(r.error_message),
    }));
  }

  /**
   * Template approval state, grouped by Meta's status. A clinic whose
   * templates are all REJECTED cannot send anything template-gated, which
   * looks identical to "WhatsApp is broken" from the clinic's side.
   *
   * `components` (the template body — message content) is not selected.
   */
  private async whatsappTemplateStatus(tenantId: string) {
    const rows = await this.dataSource.query(
      `
      SELECT status, COUNT(*)::int AS count
        FROM whatsapp_templates
       WHERE "tenantId" = $1
       GROUP BY status
       ORDER BY status ASC
      `,
      [tenantId],
    );
    return rows.map((r: { status: string; count: number }) => ({
      status: r.status,
      count: Number(r.count),
    }));
  }

  /**
   * Inbound webhook liveness. Only counts and timestamps — the `payload`
   * column is a raw Meta envelope containing private message content and is
   * never selected.
   */
  private async whatsappWebhookHealth(tenantId: string) {
    const [row] = await this.dataSource.query(
      `
      SELECT MAX(created_at)                                   AS last_received_at,
             MAX(created_at) FILTER (WHERE processed = true)   AS last_processed_at,
             COUNT(*) FILTER (WHERE processed = false
                                AND created_at >= now() - interval '7 days')::int AS unprocessed_last_7_days,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS received_last_7_days
        FROM whatsapp_webhooks
       WHERE "tenantId" = $1
      `,
      [tenantId],
    );
    const lastReceivedAt = isoOrNull(row?.last_received_at);
    return {
      lastReceivedAt,
      lastProcessedAt: isoOrNull(row?.last_processed_at),
      receivedLast7Days: Number(row?.received_last_7_days ?? 0),
      unprocessedLast7Days: Number(row?.unprocessed_last_7_days ?? 0),
      healthy: !!lastReceivedAt && Number(row?.unprocessed_last_7_days ?? 0) === 0,
    };
  }

  /**
   * Outbound/inbound message traffic, read from `notification_logs` (the
   * WhatsApp channel's own delivery ledger). `error_message` is sanitized
   * before it leaves — provider errors routinely embed URLs and identifiers.
   */
  private async whatsappTraffic(tenantId: string) {
    const [row] = await this.dataSource.query(
      `
      SELECT MAX(created_at) FILTER (WHERE status = 'SENT')   AS last_sent_at,
             MAX(created_at) FILTER (WHERE status = 'FAILED') AS last_failed_at,
             COUNT(*) FILTER (WHERE status = 'FAILED'
                                AND created_at >= now() - interval '7 days')::int AS failed_last_7_days,
             COUNT(*) FILTER (WHERE status = 'SENT'
                                AND created_at >= now() - interval '7 days')::int AS sent_last_7_days,
             (ARRAY_AGG(error_message ORDER BY created_at DESC)
                FILTER (WHERE status = 'FAILED' AND error_message IS NOT NULL))[1] AS last_error
        FROM notification_logs
       WHERE "tenantId" = $1 AND channel = 'WHATSAPP'
      `,
      [tenantId],
    );
    return {
      lastSentAt: isoOrNull(row?.last_sent_at),
      lastFailedAt: isoOrNull(row?.last_failed_at),
      sentLast7Days: Number(row?.sent_last_7_days ?? 0),
      failedLast7Days: Number(row?.failed_last_7_days ?? 0),
      lastFailureReason: sanitizeFailureReason(row?.last_error),
    };
  }

  // ── Email ────────────────────────────────────────────────────────────────

  /**
   * Email is a PLATFORM-level integration (one provider for every clinic), so
   * "configured" is a platform fact while the send history is per-clinic. Both
   * halves are reported: a clinic can be receiving nothing because the
   * platform provider is unset, or because its own sends are failing.
   */
  async email(tenantId: string) {
    const enabled = this.config.get<string>('EMAIL_ENABLED') === 'true';
    const provider = this.config.get<string>('EMAIL_PROVIDER') ?? null;
    // Presence check only — the key's VALUE is never read into a response, and
    // never logged. This mirrors how MonitoringService reports the same fact.
    const providerConfigured = !!this.config.get<string>('RESEND_API_KEY')?.trim();

    const [row] = await this.dataSource.query(
      `
      SELECT MAX(created_at) FILTER (WHERE status = 'SENT')   AS last_sent_at,
             MAX(created_at) FILTER (WHERE status = 'FAILED') AS last_failed_at,
             COUNT(*) FILTER (WHERE status = 'FAILED'
                                AND created_at >= now() - interval '7 days')::int AS failed_last_7_days,
             COUNT(*) FILTER (WHERE status = 'SENT'
                                AND created_at >= now() - interval '7 days')::int AS sent_last_7_days,
             (ARRAY_AGG(error ORDER BY created_at DESC)
                FILTER (WHERE status = 'FAILED' AND error IS NOT NULL))[1] AS last_error
        FROM email_logs
       WHERE tenant_id = $1
      `,
      [tenantId],
    );

    const failed = Number(row?.failed_last_7_days ?? 0);
    let health: IntegrationHealth = 'configured';
    if (!enabled || !providerConfigured) health = 'not_configured';
    else if (failed > 0) health = 'degraded';

    return {
      health,
      enabled,
      provider,
      /** Presence of the provider credential, never the credential. */
      providerConfigured,
      lastSentAt: isoOrNull(row?.last_sent_at),
      lastFailedAt: isoOrNull(row?.last_failed_at),
      sentLast7Days: Number(row?.sent_last_7_days ?? 0),
      failedLast7Days: failed,
      lastFailureReason: sanitizeFailureReason(row?.last_error),
    };
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  /**
   * Gateway readiness for the clinic. Reports the merchant onboarding STATE and
   * whether webhooks are arriving — the two things that actually explain "the
   * payment link doesn't work" / "the appointment is stuck pending".
   *
   * Never selected: `iban_masked` (still a bank identifier), `bank_name`,
   * `beneficiary_name`, `provider_recipient_id`, `status_history` (contains
   * reviewer identities and notes), and every gateway credential — those live
   * on `payment_gateways`, which this service does not read at all.
   */
  async payments(tenantId: string) {
    const merchant = await this.merchants.findOne({
      where: { tenant: { id: tenantId } },
      select: {
        id: true,
        status: true,
        provider: true,
        submitted_at: true,
        approved_at: true,
      },
    });

    const [row] = await this.dataSource.query(
      `
      SELECT MAX(created_at)                                          AS last_payment_at,
             MAX(paid_at)                                             AS last_paid_at,
             COUNT(*) FILTER (WHERE status = 'FAILED'
                                AND created_at >= now() - interval '7 days')::int AS failed_last_7_days,
             COUNT(*) FILTER (WHERE status = 'PENDING'
                                AND created_at >= now() - interval '7 days')::int AS pending_last_7_days
        FROM payments
       WHERE "tenantId" = $1
      `,
      [tenantId],
    );

    let health: IntegrationHealth = 'not_configured';
    if (merchant) {
      health = merchant.status === 'APPROVED' ? 'configured' : 'disconnected';
      if (health === 'configured' && Number(row?.failed_last_7_days ?? 0) > 0) {
        health = 'degraded';
      }
    }

    return {
      health,
      configured: !!merchant,
      /** Onboarding state only — no bank details, no recipient id, no history. */
      merchantStatus: merchant?.status ?? null,
      provider: merchant?.provider ?? null,
      submittedAt: isoOrNull(merchant?.submitted_at),
      approvedAt: isoOrNull(merchant?.approved_at),
      lastPaymentAt: isoOrNull(row?.last_payment_at),
      lastSuccessfulPaymentAt: isoOrNull(row?.last_paid_at),
      failedLast7Days: Number(row?.failed_last_7_days ?? 0),
      pendingLast7Days: Number(row?.pending_last_7_days ?? 0),
    };
  }

  // ── AI ───────────────────────────────────────────────────────────────────

  /**
   * AI enablement + operational health. The clinic-facing bot toggle
   * (`tenant_settings.bot_enabled`) and the platform deployment record are
   * separate switches and are reported separately — a clinic reporting "the
   * assistant stopped replying" is usually one or the other.
   *
   * `api_key_ciphertext` is excluded from the select; its presence is derived
   * in SQL. No cost, token-spend or pricing data appears here — that is
   * Super Admin's AI monitoring surface, which Support cannot reach.
   */
  async ai(tenantId: string) {
    const [deployment] = await this.dataSource.query(
      `
      SELECT enabled,
             provider,
             region,
             (api_key_ciphertext IS NOT NULL) AS has_dedicated_key,
             updated_at
        FROM tenant_ai_deployments
       WHERE tenant_id = $1
       LIMIT 1
      `,
      [tenantId],
    );

    const settings = await this.settings.findOne({
      where: { tenant: { id: tenantId } },
      select: { id: true, bot_enabled: true },
    });

    const [row] = await this.dataSource.query(
      `
      SELECT MAX(created_at)                                       AS last_activity_at,
             COUNT(*) FILTER (WHERE success = false
                                AND created_at >= now() - interval '7 days')::int AS failures_last_7_days,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS executions_last_7_days
        FROM ai_execution_metrics
       WHERE "tenantId" = $1
      `,
      [tenantId],
    );

    const botEnabled = settings?.bot_enabled ?? false;
    const deploymentEnabled = deployment?.enabled ?? false;
    const failures = Number(row?.failures_last_7_days ?? 0);

    let health: IntegrationHealth = 'not_configured';
    if (deployment) {
      health = deploymentEnabled ? 'configured' : 'disconnected';
      if (health === 'configured' && failures > 0) health = 'degraded';
    }

    return {
      health,
      /** Platform-side deployment switch. */
      deploymentEnabled,
      /** Clinic-side bot switch (tenant_settings.bot_enabled). */
      botEnabled,
      provider: deployment?.provider ?? null,
      region: deployment?.region ?? null,
      /** Presence only — the ciphertext is never read out of the database. */
      hasDedicatedKey: !!deployment?.has_dedicated_key,
      lastActivityAt: isoOrNull(row?.last_activity_at),
      executionsLast7Days: Number(row?.executions_last_7_days ?? 0),
      failuresLast7Days: failures,
    };
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  /**
   * Object storage is platform-wide, so this is a configuration fact rather
   * than a per-clinic one. Reused from `StorageService.isConfigured()` — the
   * same check the platform's own health surface uses.
   */
  private storageStatus() {
    const configured = this.storage.isConfigured();
    return {
      health: (configured ? 'configured' : 'not_configured') as IntegrationHealth,
      configured,
      scope: 'platform' as const,
    };
  }
}

interface WhatsappAccountRow {
  id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  waba_id: string | null;
  meta_business_id: string | null;
  connection_status: string;
  is_active: boolean;
  is_default: boolean;
  has_credentials: boolean;
  connected_at: Date | null;
  last_synced_at: Date | null;
  token_expires_at: Date | null;
}
