/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T129).
 *
 * Pins FR-E005 (consent required), FR-E007 (unsubscribe suppresses), FR-E008
 * (hard bounce suppresses) and — critically — FR-E009: a marketing
 * unsubscribe/suppression must NEVER block a transactional message (a
 * reminder, receipt, confirmation) to the same address. Goes straight at the
 * service/repository layer against REAL Postgres (`createE2eApp()`), the
 * same style `customer-email-uniqueness.e2e-spec.ts` uses — campaign
 * dispatch and email delivery have no HTTP-only behaviour worth routing
 * through, and this keeps the test decoupled from campaign-creation DTO
 * plumbing that has nothing to do with consent/suppression.
 */
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  cleanupTenant,
  createOwnerFixture,
  type E2eApp,
} from './utils/whatsapp-e2e-app';

import { Campaign } from '../src/entities/Campaigns/Campaign';
import { CampaignRun } from '../src/entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../src/entities/Campaigns/CampaignRecipient';
import { Customer } from '../src/entities/CRM/Customer';
import { EmailLog } from '../src/entities/System/EmailLog';
import {
  CampaignExecution,
  CampaignLifecycle,
  CampaignType,
  RecipientProcessing,
} from '../src/entities/enums';

import { CampaignDispatchService } from '../src/modules/campaigns/campaign-dispatch.service';
import { EmailSuppressionService } from '../src/modules/email/email-suppression.service';
import { EmailDeliveryService } from '../src/modules/email/email-delivery.service';

const SUITE_MARKER = `t129-${randomUUID().slice(0, 8)}`;

describe('Email campaign consent + suppression — real Postgres (T129, FR-E005/E007/E008/E009)', () => {
  let e2e: E2eApp;
  let tenantId: string;
  let dispatch: CampaignDispatchService;
  let suppression: EmailSuppressionService;
  let delivery: EmailDeliveryService;

  let campaignRepo: ReturnType<E2eApp['dataSource']['getRepository']>;
  let runRepo: ReturnType<E2eApp['dataSource']['getRepository']>;
  let recipientRepo: ReturnType<E2eApp['dataSource']['getRepository']>;
  let customerRepo: ReturnType<E2eApp['dataSource']['getRepository']>;
  let emailLogRepo: ReturnType<E2eApp['dataSource']['getRepository']>;

  let campaignId: string;
  let runId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    const owner = await createOwnerFixture(e2e, SUITE_MARKER);
    tenantId = owner.tenantId;

    dispatch = e2e.app.get(CampaignDispatchService);
    suppression = e2e.app.get(EmailSuppressionService);
    delivery = e2e.app.get(EmailDeliveryService);

    campaignRepo = e2e.dataSource.getRepository(Campaign);
    runRepo = e2e.dataSource.getRepository(CampaignRun);
    recipientRepo = e2e.dataSource.getRepository(CampaignRecipient);
    customerRepo = e2e.dataSource.getRepository(Customer);
    emailLogRepo = e2e.dataSource.getRepository(EmailLog);

    const campaign = await campaignRepo.save(
      campaignRepo.create({
        tenant: { id: tenantId },
        type: CampaignType.PROMOTION,
        name: `T129 email campaign ${SUITE_MARKER}`,
        lifecycle: CampaignLifecycle.ACTIVE,
        channel: 'EMAIL',
        email_subject: '20% off this month',
        email_body: 'Book your next visit and save.',
      }),
    );
    campaignId = campaign.id;

    const run = await runRepo.save(
      runRepo.create({
        tenant: { id: tenantId },
        campaign: { id: campaignId },
        execution: CampaignExecution.PROCESSING,
        total_recipients: 0,
        idempotency_key: randomUUID(),
      }),
    );
    runId = run.id;
  }, 60_000);

  afterAll(async () => {
    await cleanupTenant(e2e, tenantId);
    await e2e.app.close();
  }, 30_000);

  async function makeCustomer(
    label: string,
    overrides: Partial<Customer> = {},
  ) {
    return customerRepo.save(
      customerRepo.create({
        tenant: { id: tenantId },
        full_name: `T129 ${label}`,
        phone: `+9665${SUITE_MARKER.slice(-6)}${Math.floor(Math.random() * 90 + 10)}`,
        email: `${label}-${SUITE_MARKER}@example.test`,
        marketing_opt_in: true,
        is_active: true,
        ...overrides,
      }),
    );
  }

  async function addRecipient(customerId: string) {
    // The dispatcher completes a run as soon as every recipient is terminal (atomic completion
    // check), and a COMPLETED run skips any further recipient as `run-stopped`. This suite shares one
    // run across tests, so re-open it before each new recipient — the production equivalent is a run
    // that still has pending recipients.
    await runRepo.update({ id: runId }, { execution: CampaignExecution.PROCESSING });
    return recipientRepo.save(
      recipientRepo.create({
        run: { id: runId },
        campaign: { id: campaignId },
        customer: { id: customerId },
        processing: RecipientProcessing.PENDING,
      }),
    );
  }

  it('[FR-E005] a non-consenting customer is excluded, with the reason recorded', async () => {
    const customer = await makeCustomer('non-consenting', {
      marketing_opt_in: false,
    });
    const recipient = await addRecipient(customer.id);

    const outcome = await dispatch.dispatch(tenantId, runId, recipient.id);

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'no-marketing-consent',
    });
    const row = await recipientRepo.findOne({ where: { id: recipient.id } });
    expect(row?.processing).toBe(RecipientProcessing.SKIPPED);
    expect(row?.failure_reason).toBe('no-marketing-consent');
  });

  it('[FR-E007] an unsubscribed (suppressed) customer is excluded, with the reason recorded', async () => {
    const customer = await makeCustomer('unsubscribed');
    await suppression.suppress(
      tenantId,
      customer.email,
      'UNSUBSCRIBE',
      'unsubscribe_link',
    );
    const recipient = await addRecipient(customer.id);

    const outcome = await dispatch.dispatch(tenantId, runId, recipient.id);

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'email-suppressed',
    });
    const row = await recipientRepo.findOne({ where: { id: recipient.id } });
    expect(row?.processing).toBe(RecipientProcessing.SKIPPED);
    expect(row?.failure_reason).toBe('email-suppressed');
  });

  it('[FR-E008] a hard bounce suppresses the address for the NEXT campaign to it', async () => {
    const customer = await makeCustomer('bounced');

    // A bounce is recorded exactly the way the verified webhook records one
    // (T136) — write straight to the suppression list.
    await suppression.suppress(tenantId, customer.email, 'BOUNCE', 'webhook');

    // A second, later campaign run's recipient for the SAME address is now excluded.
    const laterRun = await runRepo.save(
      runRepo.create({
        tenant: { id: tenantId },
        campaign: { id: campaignId },
        execution: CampaignExecution.PROCESSING,
        total_recipients: 0,
        idempotency_key: randomUUID(),
      }),
    );
    const recipient = await recipientRepo.save(
      recipientRepo.create({
        run: { id: laterRun.id },
        campaign: { id: campaignId },
        customer: { id: customer.id },
        processing: RecipientProcessing.PENDING,
      }),
    );

    const outcome = await dispatch.dispatch(
      tenantId,
      laterRun.id,
      recipient.id,
    );

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'email-suppressed',
    });
  });

  it('[FR-E009 — CRITICAL] a marketing unsubscribe does NOT suppress a transactional reminder/receipt to the same address', async () => {
    const customer = await makeCustomer('reminder-recipient');

    // Suppress this address for MARKETING (an unsubscribe) — same as above.
    await suppression.suppress(
      tenantId,
      customer.email,
      'UNSUBSCRIBE',
      'unsubscribe_link',
    );
    const alreadySuppressed = await suppression.isSuppressed(
      tenantId,
      customer.email,
    );
    expect(alreadySuppressed).toBe(true);

    // The marketing path excludes it...
    const marketingRecipient = await addRecipient(customer.id);
    const marketingOutcome = await dispatch.dispatch(
      tenantId,
      runId,
      marketingRecipient.id,
    );
    expect(marketingOutcome).toMatchObject({
      status: 'skipped',
      reason: 'email-suppressed',
    });

    // ...but a TRANSACTIONAL appointment reminder to the SAME address, sent
    // through the SAME EmailDeliveryService every transactional send in this
    // codebase uses, completes normally — it never consults
    // `email_suppressions` at all (that is the whole point of FR-E009: the
    // marketing suppression gate lives ONLY in CampaignDispatchService).
    const idempotencyKey = `t129-reminder-${SUITE_MARKER}`;
    await delivery.deliver({
      tenantId,
      to: customer.email,
      template: 'appointment_reminder',
      variables: { name: customer.full_name, dateTime: 'tomorrow at 10:00' },
      idempotencyKey,
    });

    const log = await emailLogRepo.findOne({
      where: { idempotency_key: idempotencyKey },
    });
    expect(log?.status).toBe('SENT');
    expect(log?.to_address).toBe(customer.email);
  });
});
