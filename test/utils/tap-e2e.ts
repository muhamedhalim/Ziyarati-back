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
 * Phase 3 adds the recurring surface: `POST /v2/tokens` (saved card → single-use
 * token), `DELETE /v2/card/{customer}/{card}`, the saved-card ids a CAPTURED
 * save-card charge reports, and scripted answers for a merchant-initiated charge.
 */
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';

import { TAP_E2E_SECRET_KEY } from './tap-e2e-env.setup';

export type TapObject = Record<string, any>;

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
  /** When set, the next `POST /v2/charges` fails like an outage (no charge is created). */
  failNextCreateWith: { status: number; errorCode?: string } | null = null;

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

  readonly createRefund = jest.fn(async (body: TapObject) => {
    this.refundRequests.push(body);
    return ok({
      id: `re_${randomUUID().replace(/-/g, '')}`,
      object: 'refund',
      status: this.refundStatus,
      amount: Number(body.amount),
      currency: body.currency,
      charge: body.charge_id,
      created: String(Date.now()),
    });
  });

  readonly getRefund = jest.fn(async () => notFound());

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
