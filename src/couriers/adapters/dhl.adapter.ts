import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, BookingResult, Capabilities, CityInfo, CourierAdapter, TrackEvent, TrackResult } from '../courier.types';
import { CourierError, NotSupportedError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { chunk, parseIsoOrMsDate, pick } from '../util';

/**
 * DHL Shipment Tracking (Unified) API: covers DHL Express, Global Forwarding, Freight, eCommerce, Parcel.
 *   GET https://api-eu.dhl.com/track/shipments?trackingNumber=...     header: DHL-API-Key: <Consumer Key>
 * Sandbox and production share the same host (the key decides). A free key from developer.dhl.com is enough:
 * the merchant does NOT need a DHL Express account for tracking. (MyDHL booking API needs an Express account and
 * is intentionally not implemented here.) One tracking number per call, so bulk runs small parallel batches.
 * Response shape per the public reference; not yet run against a live key.
 */
const HOST = 'https://api-eu.dhl.com';
const PROBE = '7777777770'; // DHL's documented sample number

@Injectable()
export class DhlAdapter implements CourierAdapter {
  readonly courier = Courier.DHL;
  readonly requiredCredentials = ['apiKey'];
  readonly capabilities: Capabilities = {
    book: { supported: false, verified: true },
    track: { supported: true, verified: false },
    trackBulk: { supported: true, verified: false },
    cancel: { supported: false, verified: true },
    label: { supported: false, verified: true },
    cities: { supported: false, verified: true },
    webhook: { supported: false, verified: true },
    paymentStatus: { supported: false, verified: true },
    statusCatalog: { supported: false, verified: true },
  };

  private http(ctx: AccountContext) {
    return new CourierHttp('DHL', ctx.credentials.baseUrl || HOST, { 'DHL-API-Key': String(ctx.credentials.apiKey || ''), Accept: 'application/json' });
  }

  private params(ctx: AccountContext, tn: string) {
    const p: Record<string, string> = { trackingNumber: tn, language: 'en' };
    if (ctx.credentials.service) p.service = String(ctx.credentials.service);
    if (ctx.credentials.requesterCountryCode) p.requesterCountryCode = String(ctx.credentials.requesterCountryCode);
    return p;
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    const res = await this.http(ctx).request({ method: 'GET', url: '/track/shipments', params: this.params(ctx, PROBE) });
    if (res.status === 401 || res.status === 403) throw new CourierError('DHL', 'Unauthorized: invalid DHL API key', { httpStatus: res.status, raw: asJson(res.data) });
    // 200 or 404 (unknown number) both prove the key is accepted.
    if (res.status >= 500) throw new CourierError('DHL', `DHL API error ${res.status}`, { httpStatus: res.status, retriable: true });
  }

  async book(): Promise<BookingResult> {
    throw new NotSupportedError('DHL', 'Booking (tracking-only integration)');
  }
  async cancel(): Promise<{ ok: boolean; message?: string; raw: unknown }> {
    throw new NotSupportedError('DHL', 'Cancel');
  }
  async getLabel(): Promise<{ contentType: string; data: Buffer } | { url: string }> {
    throw new NotSupportedError('DHL', 'Labels');
  }
  async getCities(): Promise<CityInfo[]> {
    throw new NotSupportedError('DHL', 'City list');
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const res = await this.http(ctx).request({ method: 'GET', url: '/track/shipments', params: this.params(ctx, trackingNumber) });
    const body = asJson(res.data);
    if (res.status === 401 || res.status === 403) throw new CourierError('DHL', 'Unauthorized: invalid DHL API key', { httpStatus: res.status, raw: body });
    if (res.status === 429) throw new CourierError('DHL', 'DHL rate limit reached (daily/second quota of the API key)', { httpStatus: 429, retriable: true, raw: body });
    if (res.status === 404) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: String(pick(body, 'title', 'detail') ?? 'Not found'), events: [], raw: body };
    if (res.status >= 400) throw new CourierError('DHL', `Track request failed: ${pick(body, 'detail', 'title') ?? res.status}`, { httpStatus: res.status, retriable: res.status >= 500, raw: body });
    return this.parse(trackingNumber, (body?.shipments ?? [])[0], body);
  }

  async trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]> {
    const out: TrackResult[] = [];
    for (const group of chunk(trackingNumbers, 5)) out.push(...(await Promise.all(group.map((tn) => this.track(ctx, tn)))));
    return out;
  }

  private parse(tn: string, sh: any, raw: unknown): TrackResult {
    if (!sh) return { trackingNumber: tn, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'Not found', events: [], raw };
    const events: TrackEvent[] = [];
    for (const e of sh.events ?? []) {
      const at = parseIsoOrMsDate(e.timestamp);
      if (!at) continue;
      const rawStatus = String(pick(e, 'description', 'status') ?? '');
      const addr = e.location?.address;
      events.push({
        status: mapStatus(Courier.DHL, rawStatus, e.statusCode).status,
        rawStatus,
        occurredAt: at,
        location: [addr?.addressLocality, addr?.countryCode].filter(Boolean).join(', ') || undefined,
        note: pick(e, 'remark', 'nextSteps'),
      });
    }
    const st = sh.status;
    const headRaw = String(pick(st, 'description', 'status') ?? '');
    const head = st ? mapStatus(Courier.DHL, headRaw, st.statusCode) : undefined;
    if (!events.length && st) events.push({ status: head!.status, rawStatus: headRaw, occurredAt: parseIsoOrMsDate(st.timestamp) ?? new Date() });
    const cur = resolveCurrent(events);
    const status = head?.matched && head.status !== ShipmentStatus.UNKNOWN ? head.status : cur?.status ?? ShipmentStatus.UNKNOWN;
    const rawStatus = head?.matched ? headRaw : cur?.rawStatus ?? headRaw;
    const pod = sh.details?.proofOfDelivery;
    const deliveredAt = status === ShipmentStatus.DELIVERED ? parseIsoOrMsDate(pod?.timestamp ?? st?.timestamp) ?? cur?.occurredAt : undefined;
    return { trackingNumber: tn, found: true, status, rawStatus, events, deliveredAt, receiverName: pick(pod?.signed, 'name'), raw: sh };
  }
}
