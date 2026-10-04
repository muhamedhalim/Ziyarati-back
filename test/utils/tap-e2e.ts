/**
 * Tap e2e helpers (Tap migration, Phase 2). Import `./tap-e2e-env.setup` FIRST
 * in the spec — before anything that pulls AppModule.
 *
 * `TapSandbox` is a stand-in for Tap's API at the `TapApiClient` boundary: it
 * answers `POST /charges`, `GET /charges/{id}`, `POST /refunds` the way the real
 * API does, keeps the request bodies so a spec can assert what was SENT, and
 * produces correctly SIGNED webhook deliveries. No request ever leaves the
 * machine.
 *
 * Phase 4 adds clinic onboarding: `POST /v3/lead` and `POST /v3/connect`, with
 * scripted outcomes (`leadResult`, `connectResult`) and the request bodies kept
 * so a spec can assert exactly what the app sent.
 *
 * Phase 3 adds the recurring surface: `POST /v2/tokens` (saved card → single-use
 * token), `DELETE /v2/card/{customer}/{card}`, the saved-card ids a CAPTURED
 * save-card charge reports, and scripted answers for a merchant-initiated charge.
 */
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';

import { TAP_E2E_SECRET_KEY } from './tap-e2e-env.setup';

export type TapObject = Record<string, any>;

/** The columns of Tap's charges report, in the documented order. */
export const REPORT_COLUMNS = [
  'payout_id',
  'settlement_id',
  'charge_id',
  'currency',
  'amount',
  'status',
  'authorization_id',
  'status_code',
  'status_message',
  'gateway_code',
  'gateway_message',
  'issuer_code',
  'issuer_message',
  'charge_date',
  'capture_date',
  'post_date',
  'settlement_date',
  'payout_date',
  'track_id',
  'reference_gateway',
  'reference_acquirer',
  'reference_transaction',
  'reference_order',
  'receipt',
  'customer_id',
  'customer_name',
  'customer_phone_code',
  'customer_phone',
  'customer_email',
  'first_eight',
  'last_four',
  'issuer_country',
  'payment_method',
  'payment_scheme',
  'payment_type',
  'merchant_id',
  'product',
  'post_currency',
  'post_amount',
  'fee',
  'fee_vat',
  'net_amount',
  'metadata_1',
  'metadata_2',
  'metadata_3',
  'metadata_4',
  'metadata_5',
] as const;

const WEBHOOK_ROUTE = '/api/v1/payments/webhooks/tap';

/**
 * Independent signer: the documented formula, written out by hand — not the
 * code under test (same discipline as test/tap-webhook.e2e-spec.ts).
 */
export function signTap(obj: TapObject): string {
  const created =
    obj.object === 'refund' ? obj.created : obj.transaction?.created;
  const canonical =
    `x_id${obj.id}x_amount${Number(obj.amount).toFixed(2)}x_currency${obj.currency}` +
    `x_gateway_reference${obj.reference?.gateway ?? ''}x_payment_reference${obj.reference?.payment ?? ''}` +
    `x_status${obj.status}x_created${created}`;
  return createHmac('sha256', TAP_E2E_SECRET_KEY)
    .update(canonical)
    .digest('hex');
}

const ok = (json: TapObject) => ({
  ok: true,
  status: 200,
  json,
  transient: false,
});
const notFound = () => ({
  ok: false,
  status: 404,
  json: {},
  transient: false,
  errorCode: '1142',
});

export class TapSandbox {
  /** What Tap answers to `GET /v2/charges/{id}`, keyed by charge id. */
  readonly charges = new Map<string, TapObject>();
  /** The bodies the app sent to `POST /v2/charges`, in order. */
  readonly chargeRequests: TapObject[] = [];
  /** The bodies the app sent to `POST /v2/refunds`, in order. */
  readonly refundRequests: TapObject[] = [];
  /** Status the next refund is answered with. REFUNDED = synchronous success. */
  refundStatus = 'REFUNDED';
  /** Every refund Tap holds, by id — what `GET /v2/refunds/{id}` answers. */
  readonly refunds = new Map<string, TapObject>();
  /** Tap's `reference.idempotent` memory: the same key returns the ORIGINAL refund (24h). */
  private readonly refundsByIdempotentKey = new Map<string, string>();
  /**
   * When set, the next `POST /v2/refunds` is answered with this failure. With
   * `created: true` Tap DID create the refund before the answer was lost (the
   * dangerous case: a timeout / 5xx after the money moved).
   */
  failNextRefundWith: {
    status: number;
    errorCode?: string;
    created?: boolean;
  } | null = null;
  /** When true, `GET /v2/refunds/{id}` answers 503 (a Tap outage). */
  refundLookupOutage = false;
  /** The bodies the app sent to `POST /v2/tokens`, in order. */
  readonly tokenRequests: TapObject[] = [];
  /** `DELETE /v2/card/{customer}/{card}` calls, in order. */
  readonly deletedCards: Array<{ customerId: string; cardId: string }> = [];
  /** `ok` = the token is issued; `gone` = Tap no longer knows the saved card (1106). */
  tokenResult: 'ok' | 'gone' = 'ok';
  /**
   * What the next MERCHANT-INITIATED charge (`customer_initiated: false`) is
   * answered with. CAPTURED = the renewal is paid; INITIATED = accepted but not
   * resolved yet; DECLINED = the card refused.
   */
  mitStatus: 'CAPTURED' | 'INITIATED' | 'DECLINED' = 'CAPTURED';
  /** The bodies the app sent to `POST /v3/lead`, in order. */
  readonly leadRequests: TapObject[] = [];
  /** The bodies the app sent to `POST /v3/connect`, in order. */
  readonly connectRequests: TapObject[] = [];
  /** `ok` = Tap creates the lead; `rejected` = a 400; `outage` = a 503. */
  leadResult: 'ok' | 'rejected' | 'outage' = 'ok';
  /** `ok` = a hosted https URL; `outage` = a 503; `http` = an insecure URL; `none` = no URL. */
  connectResult: 'ok' | 'outage' | 'http' | 'none' = 'ok';
  /** When set, the next `POST /v2/charges` fails like an outage (no charge is created). */
  failNextCreateWith: { status: number; errorCode?: string } | null = null;

  // ── Phase 5: reporting (charges download, payouts list, charges list) ─────── //

  /**
   * The charges-report rows Tap holds, per merchant id (keyed as sent in
   * `merchants[]`). A merchant with no entry, and no `reportAccess`, is answered
   * 403 — the way Tap answers a platform key for a sub-merchant it will not
   * report on — so a spec only ever sees the merchants it set up.
   */
  readonly reportRows = new Map<string, Array<Record<string, string>>>();
  /** `ok` (default when rows exist) | `denied` (4xx) | `outage` (503) | `garbage` (200 but not a report). */
  readonly reportAccess = new Map<
    string,
    'ok' | 'denied' | 'outage' | 'garbage'
  >();
  /** The bodies the app sent to `POST /v2/charges/download`, in order. */
  readonly reportRequests: TapObject[] = [];
  /** Payouts Tap made, per merchant id. */
  readonly merchantPayouts = new Map<string, TapObject[]>();
  readonly payoutRequests: TapObject[] = [];
  /** When set, a report page holds at most this many rows (exercises paging headers). */
  maxReportPage: number | undefined;
  /** When true, `has_more` is reported for the LAST page too with no cursor (an unfinishable report). */
  endlessReport = false;

  /** Add a row to a merchant's charges report; every column Tap documents, blank unless given. */
  addReportRow(merchantId: string, row: Record<string, string | number>) {
    const rows = this.reportRows.get(merchantId) ?? [];
    const full: Record<string, string> = {};
    for (const col of REPORT_COLUMNS) full[col] = '';
    full.merchant_id = merchantId;
    for (const [k, v] of Object.entries(row)) full[k] = String(v);
    rows.push(full);
    this.reportRows.set(merchantId, rows);
    return full;
  }

  /** The CSV text of a set of report rows, header first. */
  static csv(rows: Array<Record<string, string>>): string {
    const cell = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    return [
      REPORT_COLUMNS.join(','),
      ...rows.map((r) => REPORT_COLUMNS.map((c) => cell(r[c] ?? '')).join(',')),
    ].join('\n');
  }

  readonly downloadCharges = jest.fn(async (body: TapObject) => {
    this.reportRequests.push(body);
    const merchantId = String(body.merchants?.[0] ?? '');
    const access =
      this.reportAccess.get(merchantId) ??
      (this.reportRows.has(merchantId) ? 'ok' : 'denied');
    if (access === 'denied') {
      return {
        ok: false,
        status: 403,
        json: {},
        transient: false,
        errorCode: '2106',
      };
    }
    if (access === 'outage') {
      return { ok: false, status: 503, json: {}, transient: true };
    }
    if (access === 'garbage') {
      return {
        ok: true,
        status: 200,
        json: '<html>nope</html>',
        transient: false,
        headers: {},
      };
    }
    let rows = [...(this.reportRows.get(merchantId) ?? [])];
    const payoutId: string | undefined = body.payouts?.payout_id?.[0];
    if (payoutId) rows = rows.filter((r) => r.payout_id === payoutId);
    const after = body.starting_after;
    if (after) {
      const i = rows.findIndex((r) => r.charge_id === after);
      rows = i >= 0 ? rows.slice(i + 1) : rows;
    }
    const size = this.maxReportPage ?? Number(body.limit ?? 25);
    const page = rows.slice(0, size);
    const more = rows.length > page.length;
    return {
      ok: true,
      status: 200,
      json: TapSandbox.csv(page),
      transient: false,
      headers: {
        has_more: String(more || (this.endlessReport && page.length > 0)),
        ...(more ? { last_charge_id: page[page.length - 1].charge_id } : {}),
      },
    };
  });

  readonly listPayouts = jest.fn(async (body: TapObject) => {
    this.payoutRequests.push(body);
    const merchantId = String(body.merchants?.[0] ?? '');
    const payouts = this.merchantPayouts.get(merchantId);
    if (!payouts) {
      return {
        ok: false,
        status: 403,
        json: {},
        transient: false,
        errorCode: '2106',
      };
    }
    return ok({
      object: 'list',
      has_more: false,
      count: payouts.length,
      payouts,
    });
  });

  /** When true, `POST /v2/charges/list` answers 503. */
  chargeListOutage = false;

  readonly listCharges = jest.fn(async (body: TapObject) => {
    if (this.chargeListOutage) {
      return { ok: false, status: 503, json: {}, transient: true };
    }
    const wanted: string[] = body.reference?.transaction ?? [];
    const found = [...this.charges.values()].filter((c) =>
      wanted.includes(c.reference?.transaction),
    );
    return ok({
      object: 'list',
      has_more: false,
      count: found.length,
      charges: found,
    });
  });

  readonly createCharge = jest.fn(async (body: TapObject) => {
    this.chargeRequests.push(body);
    if (this.failNextCreateWith) {
      const { status, errorCode } = this.failNextCreateWith;
      this.failNextCreateWith = null;
      return {
        ok: false,
        status,
        json: {},
        transient: status === 0 || status >= 500 || status === 429,
        errorCode,
      };
    }
    const id = `chg_${randomUUID().replace(/-/g, '')}`;
    const merchantInitiated = body.customer_initiated === false;
    const charge: TapObject = {
      id,
      object: 'charge',
      status: merchantInitiated ? this.mitStatus : 'INITIATED',
      amount: Number(body.amount),
      currency: body.currency,
      reference: { transaction: body.reference?.transaction },
      metadata: body.metadata,
      merchant: body.merchant,
      // remembered so `capture()` can report the card a save-card charge saved
      save_card: body.save_card === true,
      customer_initiated: body.customer_initiated,
      transaction: {
        created: String(Date.now()),
        url: `https://checkout.tap.test/${id}`,
      },
    };
    if (merchantInitiated) {
      // charged on the saved card: the same customer / agreement come back
      charge.customer = { id: body.customer?.id };
      charge.payment_agreement = body.payment_agreement;
      if (this.mitStatus === 'CAPTURED') {
        charge.reference = {
          ...charge.reference,
          gateway: 'GW1',
          payment: 'PAY1',
        };
        charge.source = { payment_method: 'VISA' };
      } else if (this.mitStatus === 'DECLINED') {
        charge.response = { code: '510' };
      }
    }
    this.charges.set(id, charge);
    return ok(charge);
  });

  readonly createLead = jest.fn(async (body: TapObject) => {
    this.leadRequests.push(body);
    if (this.leadResult === 'rejected') {
      return { ok: false, status: 400, json: {}, transient: false };
    }
    if (this.leadResult === 'outage') {
      return { ok: false, status: 503, json: {}, transient: true };
    }
    return ok({ id: `led_${randomUUID().replace(/-/g, '')}`, object: 'lead' });
  });

  readonly createConnect = jest.fn(async (body: TapObject) => {
    this.connectRequests.push(body);
    if (this.connectResult === 'outage') {
      return { ok: false, status: 503, json: {}, transient: true };
    }
    const id = `connect_${randomUUID().replace(/-/g, '')}`;
    const url =
      this.connectResult === 'http'
        ? `http://connect.tap.test/${id}`
        : this.connectResult === 'none'
          ? undefined
          : `https://connect.tap.test/${id}`;
    return ok({ id, ...(url ? { connect: { url } } : {}) });
  });

  readonly createTokenFromSavedCard = jest.fn(async (body: TapObject) => {
    this.tokenRequests.push(body);
    if (this.tokenResult === 'gone') {
      return {
        ok: false,
        status: 404,
        json: {},
        transient: false,
        errorCode: '1106',
      };
    }
    return ok({
      id: `tok_${randomUUID().replace(/-/g, '')}`,
      status: 'ACTIVE',
    });
  });

  readonly deleteSavedCard = jest.fn(
    async (customerId: string, cardId: string) => {
      this.deletedCards.push({ customerId, cardId });
      return ok({ deleted: true, id: cardId });
    },
  );

  readonly getCharge = jest.fn(async (id: string) => {
    const charge = this.charges.get(id);
    return charge ? ok(charge) : notFound();
  });

  private newRefund(body: TapObject, status: string): TapObject {
    const refund: TapObject = {
      id: `re_${randomUUID().replace(/-/g, '')}`,
      object: 'refund',
      status,
      amount: Number(body.amount),
      currency: body.currency,
      charge_id: body.charge_id,
      reference: { merchant: body.reference?.merchant },
      created: String(Date.now()),
    };
    this.refunds.set(refund.id, refund);
    if (body.reference?.idempotent) {
      this.refundsByIdempotentKey.set(body.reference.idempotent, refund.id);
    }
    return refund;
  }

  readonly createRefund = jest.fn(async (body: TapObject) => {
    this.refundRequests.push(body);

    // Tap's idempotency: the same key returns the original refund, never a second.
    const seen = body.reference?.idempotent
      ? this.refundsByIdempotentKey.get(body.reference.idempotent)
      : undefined;
    if (seen) return ok(this.refunds.get(seen)!);

    if (this.failNextRefundWith) {
      const { status, errorCode, created } = this.failNextRefundWith;
      this.failNextRefundWith = null;
      if (created) this.newRefund(body, this.refundStatus);
      return {
        ok: false,
        status,
        json: {},
        transient: status === 0 || status >= 500 || status === 429,
        errorCode,
      };
    }
    return ok(this.newRefund(body, this.refundStatus));
  });

  readonly getRefund = jest.fn(async (id: string) => {
    if (this.refundLookupOutage) {
      return { ok: false, status: 503, json: {}, transient: true };
    }
    const refund = this.refunds.get(id);
    return refund ? ok(refund) : notFound();
  });

  /** The refund `createRefund` last created (what the app stored as `gateway_refund_id`). */
  lastRefund(): TapObject {
    const all = [...this.refunds.values()];
    return all[all.length - 1];
  }

  /** Move a refund to a new status the way Tap does when its wallet check / issuer answer lands. */
  setRefundStatus(id: string, status: string, over: TapObject = {}): TapObject {
    const refund = this.refunds.get(id)!;
    Object.assign(refund, { status }, over);
    if (status === 'DECLINED' || status === 'FAILED') {
      refund.response = { code: '505', message: 'issuer text' };
    }
    return refund;
  }

  /** POST a refund to the webhook route, correctly signed. */
  deliverRefund(
    app: INestApplication,
    refund: TapObject,
    header?: string | null,
  ) {
    return this.deliver(app, refund, header);
  }

  /** Value for `builder.overrideProvider(TapApiClient).useValue(...)`. */
  asClient() {
    return {
      isConfigured: true,
      createCharge: this.createCharge,
      getCharge: this.getCharge,
      createRefund: this.createRefund,
      getRefund: this.getRefund,
      createTokenFromSavedCard: this.createTokenFromSavedCard,
      deleteSavedCard: this.deleteSavedCard,
      createLead: this.createLead,
      createConnect: this.createConnect,
      downloadCharges: this.downloadCharges,
      listPayouts: this.listPayouts,
      listCharges: this.listCharges,
    };
  }

  /** The charge `createCharge` last created (what the app stored as `gateway_payment_id`). */
  lastCharge(): TapObject {
    const all = [...this.charges.values()];
    return all[all.length - 1];
  }

  /**
   * Move a charge to CAPTURED the way Tap reports a successful payment. A charge
   * that was created with `save_card: true` also reports the saved card
   * (customer / card / payment agreement ids) — unless `savedCard: false`.
   */
  capture(
    id: string,
    over: TapObject = {},
    opts: { savedCard?: boolean } = {},
  ): TapObject {
    const charge = this.charges.get(id)!;
    Object.assign(charge, {
      status: 'CAPTURED',
      reference: { ...charge.reference, gateway: 'GW1', payment: 'PAY1' },
      source: { payment_method: 'MADA' },
    });
    if (charge.save_card && opts.savedCard !== false) {
      const tail = id.slice(-12);
      Object.assign(charge, {
        customer: { id: `cus_${tail}` },
        card: {
          id: `card_${tail}`,
          brand: 'VISA',
          scheme: 'VISA',
          last_four: '1019',
        },
        payment_agreement: { id: `payment_agreement_${tail}` },
      });
    }
    Object.assign(charge, over);
    return charge;
  }

  /** Move a charge to a failed state (Tap posts only CAPTURED / failed events). */
  decline(id: string, status = 'DECLINED'): TapObject {
    const charge = this.charges.get(id)!;
    Object.assign(charge, { status, response: { code: '510' } });
    return charge;
  }

  /** POST the charge to the webhook route, correctly signed. */
  deliver(app: INestApplication, charge: TapObject, header?: string | null) {
    const r = request(app.getHttpServer()).post(WEBHOOK_ROUTE);
    return (
      header === null ? r : r.set('hashstring', header ?? signTap(charge))
    ).send(charge);
  }
}

/** `payment-webhook.service` emits domain events fire-and-forget; let them drain. */
export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
