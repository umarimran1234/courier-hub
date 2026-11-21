import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import {
  AccountContext,
  BookingInput,
  BookingResult,
  Capabilities,
  CityInfo,
  CourierAdapter,
  TrackEvent,
  TrackResult,
} from '../courier.types';
import { CourierError, NotSupportedError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { chunk, normalizePkPhone, parseCourierDate, pick } from '../util';

/**
 * PostEx Merchant API (v4.1.9). Base: https://api.postex.pk/services/integration/api/order
 * Auth: `token` header (merchant API key from the PostEx dashboard).
 *
 * Endpoint paths confirmed from public wrappers; the exact response field names for tracking are
 * parsed defensively (several aliases) because PostEx publishes no OpenAPI spec.
 */
const BASE = 'https://api.postex.pk/services/integration/api/order';
const NOT_FOUND_RE = /not found|no order|no record|invalid (tracking|order)|does not exist|no data/i;

@Injectable()
export class PostexAdapter implements CourierAdapter {
  readonly courier = Courier.POSTEX;
  readonly requiredCredentials = ['token'];
  readonly capabilities: Capabilities = {
    book: { supported: true, verified: true },
    track: { supported: true, verified: false },
    trackBulk: { supported: true, verified: false },
    cancel: { supported: true, verified: true },
    label: { supported: false, verified: true },
    cities: { supported: true, verified: true },
    webhook: { supported: false, verified: true },
    paymentStatus: { supported: true, verified: true },
    statusCatalog: { supported: true, verified: true },
  };

  private http(ctx: AccountContext) {
    return new CourierHttp('POSTEX', ctx.credentials.baseUrl || BASE, { token: String(ctx.credentials.token || '') });
  }

  private body(res: { status: number; data: any }, what: string) {
    const body = asJson(res.data);
    if (res.status === 401 || res.status === 403) {
      throw new CourierError('POSTEX', 'Unauthorized: invalid or expired API token', { httpStatus: res.status, raw: body });
    }
    const code = String(pick(body, 'statusCode') ?? res.status);
    if (!code.startsWith('2')) {
      const msg = pick(body, 'statusMessage', 'message', 'error') ?? `HTTP ${res.status}`;
      throw new CourierError('POSTEX', `${what} failed: ${msg}`, { httpStatus: res.status, raw: body });
    }
    return body;
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    const res = await this.http(ctx).request({ method: 'GET', url: '/v2/get-operational-city' });
    this.body(res, 'Credential check');
  }

  async book(ctx: AccountContext, input: BookingInput): Promise<BookingResult> {
    const orderType = input.orderType === 'REVERSE' ? 'Reverse' : input.orderType === 'REPLACEMENT' ? 'Replacement' : 'Normal';
    const payload: Record<string, any> = {
      cityName: input.consignee.city,
      customerName: input.consignee.name,
      customerPhone: normalizePkPhone(input.consignee.phone),
      deliveryAddress: input.consignee.address,
      invoiceDivision: 1,
      invoicePayment: String(Math.round(input.codAmount)),
      items: input.pieces,
      orderDetail: input.itemsDescription || `Order ${input.orderRef}`,
      orderRefNumber: input.orderRef,
      orderType,
      transactionNotes: input.remarks || '',
      pickupAddressCode: input.pickupAddressCode || ctx.credentials.pickupAddressCode || '',
    };
    if (ctx.credentials.storeAddressCode) payload.storeAddressCode = ctx.credentials.storeAddressCode;

    const res = await this.http(ctx).request({ method: 'POST', url: '/v3/create-order', data: payload, headers: { 'Content-Type': 'application/json' } }, { retries: 0 });
    const body = this.body(res, 'Create order');
    const tn = pick(body?.dist, 'trackingNumber', 'tracking_number');
    if (!tn) throw new CourierError('POSTEX', 'Create order succeeded but no tracking number was returned', { raw: body });
    return { trackingNumber: String(tn), raw: body };
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const res = await this.http(ctx).request({ method: 'GET', url: `/v1/track-order/${encodeURIComponent(trackingNumber)}` });
    const raw = asJson(res.data);
    if (res.status === 401 || res.status === 403) this.body(res, 'Track');
    const code = String(pick(raw, 'statusCode') ?? res.status);
    const msg = String(pick(raw, 'statusMessage', 'message') ?? '');
    if (!code.startsWith('2')) {
      if (res.status === 404 || NOT_FOUND_RE.test(msg)) return this.notFound(trackingNumber, raw);
      throw new CourierError('POSTEX', `Track failed: ${msg || code}`, { raw, httpStatus: res.status });
    }
    const dist = pick(raw, 'dist', 'data', 'result');
    if (!dist) return this.notFound(trackingNumber, raw);
    return this.parseTracking(trackingNumber, Array.isArray(dist) ? dist[0] : dist, raw);
  }

  async trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]> {
    const out: TrackResult[] = [];
    for (const group of chunk(trackingNumbers, 50)) {
      let parsed: TrackResult[] | null = null;
      try {
        // PostEx bulk tracking is a GET that carries a JSON body.
        const res = await this.http(ctx).request({
          method: 'GET',
          url: '/v1/track-bulk-order',
          data: { trackingNumber: group },
          headers: { 'Content-Type': 'application/json' },
        });
        const raw = asJson(res.data);
        const code = String(pick(raw, 'statusCode') ?? res.status);
        const dist = pick(raw, 'dist', 'data', 'result');
        if (code.startsWith('2') && Array.isArray(dist)) {
          const byTn = new Map<string, any>();
          for (const d of dist) {
            const tn = pick(d, 'trackingNumber', 'tracking_number');
            if (tn) byTn.set(String(tn), d);
          }
          // Only trust bulk if it returned a row for every number; otherwise fall back per-number for the misses.
          parsed = group.map((tn) => (byTn.has(tn) ? this.parseTracking(tn, byTn.get(tn), raw) : (null as any)));
          const missing = group.filter((_, i) => !parsed![i]);
          for (const tn of missing) {
            parsed[group.indexOf(tn)] = await this.track(ctx, tn);
          }
        }
      } catch (e) {
        if (e instanceof CourierError && /Unauthorized/.test(e.message)) throw e;
        parsed = null;
      }
      if (!parsed) {
        parsed = [];
        for (const tn of group) {
          try {
            parsed.push(await this.track(ctx, tn));
          } catch (e) {
            if (e instanceof CourierError && /Unauthorized/.test(e.message)) throw e;
            parsed.push({ ...this.notFound(tn, { error: (e as Error).message }), found: false });
          }
        }
      }
      out.push(...parsed);
    }
    return out;
  }

  async cancel(ctx: AccountContext, trackingNumber: string) {
    const res = await this.http(ctx).request({ method: 'PUT', url: '/v1/cancel-order', data: { trackingNumber }, headers: { 'Content-Type': 'application/json' } }, { retries: 0 });
    const body = this.body(res, 'Cancel order');
    return { ok: true, message: String(pick(body, 'statusMessage') ?? 'Cancelled'), raw: body };
  }

  async getLabel(): Promise<never> {
    // PostEx airway-bill / load-sheet endpoints are not publicly documented.
    throw new NotSupportedError('POSTEX', 'Label printing via API');
  }

  async getCities(ctx: AccountContext): Promise<CityInfo[]> {
    const res = await this.http(ctx).request({ method: 'GET', url: '/v2/get-operational-city' });
    const body = this.body(res, 'Get cities');
    const list: any[] = Array.isArray(body?.dist) ? body.dist : [];
    return list
      .map((c) => ({ name: String(pick(c, 'operationalCityName', 'cityName', 'name') ?? ''), extra: c }))
      .filter((c) => c.name);
  }

  async getPaymentStatus(ctx: AccountContext, trackingNumber: string) {
    const res = await this.http(ctx).request({ method: 'GET', url: `/v1/payment-status/${encodeURIComponent(trackingNumber)}` });
    return this.body(res, 'Payment status');
  }

  async getStatusCatalog(ctx: AccountContext) {
    const res = await this.http(ctx).request({ method: 'GET', url: '/v1/get-order-status' });
    return this.body(res, 'Order status list');
  }

  // ---------------------------------------------------------------- parsing

  private notFound(trackingNumber: string, raw: unknown): TrackResult {
    return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'NOT_FOUND', events: [], raw };
  }

  private parseTracking(trackingNumber: string, d: any, raw: unknown): TrackResult {
    const history: any[] = pick(d, 'transactionStatusHistory', 'statusHistory', 'history', 'trackingHistory') ?? [];
    const events: TrackEvent[] = (Array.isArray(history) ? history : []).map((h, i) => {
      const rawStatus = String(pick(h, 'transactionStatusMessage', 'statusMessage', 'transactionStatus', 'status', 'message') ?? '');
      const code = pick(h, 'transactionStatusMessageCode', 'statusCode', 'code');
      const when = parseCourierDate(pick(h, 'modifiedDatetime', 'updatedAt', 'dateTime', 'datetime', 'date', 'transactionDate'));
      return {
        status: mapStatus(Courier.POSTEX, rawStatus, undefined).status,
        rawStatus: rawStatus + (code ? ` [${code}]` : ''),
        occurredAt: when ?? new Date(i), // keep API order if unparsable
        note: pick(h, 'reason', 'remarks', 'note'),
      };
    });

    const headline = String(pick(d, 'transactionStatus', 'orderStatus', 'status') ?? '');
    const cur = resolveCurrent(events);
    const headMap = headline ? mapStatus(Courier.POSTEX, headline) : undefined;
    // Headline status is the courier's authoritative "current" value; fall back to history.
    const status = headMap?.matched ? headMap.status : cur?.status ?? ShipmentStatus.UNKNOWN;
    const rawStatus = headline || cur?.rawStatus || '';

    const delivered = events.filter((e) => e.status === ShipmentStatus.DELIVERED).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).pop();
    return {
      trackingNumber,
      found: true,
      status,
      rawStatus,
      events,
      deliveredAt: status === ShipmentStatus.DELIVERED ? delivered?.occurredAt : undefined,
      receiverName: pick(d, 'receivedBy', 'receiverName'),
      raw,
    };
  }
}
