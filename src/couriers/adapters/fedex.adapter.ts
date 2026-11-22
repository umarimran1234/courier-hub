import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, BookingInput, BookingResult, Capabilities, CityInfo, CourierAdapter, TrackEvent, TrackResult } from '../courier.types';
import { CourierError, NotSupportedError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { TtlCache, chunk, parseIsoOrMsDate, pick } from '../util';

/**
 * FedEx Track API (REST, "Basic Integrated Visibility").
 *  production: https://apis.fedex.com        sandbox: https://apis-sandbox.fedex.com
 * Auth: OAuth 2.0. POST /oauth/token (x-www-form-urlencoded) grant_type=client_credentials, client_id, client_secret
 *       -> bearer token valid 60 min (cached 55). Compatible/parent-child customers add childKey/childSecret
 *       (grant_type csp_credentials).
 * Tracking: POST /track/v1/trackingnumbers  {includeDetailedScans, trackingInfo:[{trackingNumberInfo:{trackingNumber}}]}
 *       up to 30 numbers per request.
 * Booking (Ship API) needs account, customs and payment data and is intentionally not implemented: this adapter is tracking-only.
 * Response field names follow the public Track API reference but have not been run against a live account.
 */
const PROD = 'https://apis.fedex.com';
const SANDBOX = 'https://apis-sandbox.fedex.com';

@Injectable()
export class FedexAdapter implements CourierAdapter {
  readonly courier = Courier.FEDEX;
  readonly requiredCredentials = ['clientId', 'clientSecret'];
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

  private tokens = new TtlCache<string>(55 * 60 * 1000);

  private http(ctx: AccountContext) {
    return new CourierHttp('FEDEX', ctx.credentials.baseUrl || (ctx.sandbox ? SANDBOX : PROD));
  }

  private async token(ctx: AccountContext, force = false): Promise<string> {
    const key = `${ctx.id}:${ctx.sandbox}`;
    if (!force) {
      const c = this.tokens.get(key);
      if (c) return c;
    }
    const c = ctx.credentials;
    const form = new URLSearchParams();
    if (c.childKey && c.childSecret) {
      form.set('grant_type', 'csp_credentials');
      form.set('child_key', String(c.childKey));
      form.set('child_secret', String(c.childSecret));
    } else {
      form.set('grant_type', 'client_credentials');
    }
    form.set('client_id', String(c.clientId));
    form.set('client_secret', String(c.clientSecret));
    const res = await this.http(ctx).request({ method: 'POST', url: '/oauth/token', data: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const body = asJson(res.data);
    const t = pick(body, 'access_token');
    if (!t) {
      const msg = pick(body?.errors?.[0], 'message') ?? pick(body, 'error_description', 'message') ?? `HTTP ${res.status}`;
      throw new CourierError('FEDEX', `Unauthorized: ${msg} (check clientId/clientSecret and that the project is approved for this environment)`, { httpStatus: res.status, raw: body });
    }
    this.tokens.set(key, String(t));
    return String(t);
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    await this.token(ctx, true);
  }

  async book(): Promise<BookingResult> {
    throw new NotSupportedError('FEDEX', 'Booking (tracking-only integration)');
  }
  async cancel(): Promise<{ ok: boolean; message?: string; raw: unknown }> {
    throw new NotSupportedError('FEDEX', 'Cancel');
  }
  async getLabel(): Promise<{ contentType: string; data: Buffer } | { url: string }> {
    throw new NotSupportedError('FEDEX', 'Labels');
  }
  async getCities(): Promise<CityInfo[]> {
    throw new NotSupportedError('FEDEX', 'City list');
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const [r] = await this.trackMany(ctx, [trackingNumber]);
    return r;
  }

  async trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]> {
    const out: TrackResult[] = [];
    for (const group of chunk(trackingNumbers, 30)) {
      let body: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.token(ctx, attempt > 0);
        const res = await this.http(ctx).request({
          method: 'POST',
          url: '/track/v1/trackingnumbers',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
          data: { includeDetailedScans: true, trackingInfo: group.map((tn) => ({ trackingNumberInfo: { trackingNumber: tn } })) },
        });
        body = asJson(res.data);
        if (res.status === 401 && attempt === 0) continue;
        if (res.status === 401) throw new CourierError('FEDEX', 'Unauthorized: token rejected', { httpStatus: 401, raw: body });
        if (res.status === 429) throw new CourierError('FEDEX', 'Rate limited by FedEx', { httpStatus: 429, retriable: true, raw: body });
        if (res.status >= 400) throw new CourierError('FEDEX', `Track request failed: ${pick(body?.errors?.[0], 'message') ?? res.status}`, { httpStatus: res.status, raw: body });
        break;
      }
      const results: any[] = body?.output?.completeTrackResults ?? [];
      const byTn = new Map<string, any>();
      for (const cr of results) {
        const tr = (cr?.trackResults ?? [])[0];
        const tn = String(pick(cr, 'trackingNumber') ?? tr?.trackingNumberInfo?.trackingNumber ?? '');
        if (tn) byTn.set(tn, tr ?? {});
      }
      for (const tn of group) out.push(this.parse(tn, byTn.get(tn), body));
    }
    return out;
  }

  private parse(tn: string, tr: any, raw: unknown): TrackResult {
    const notFound = !tr || tr.error || (!tr.latestStatusDetail && !(tr.scanEvents ?? []).length);
    if (notFound) return { trackingNumber: tn, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: String(pick(tr?.error, 'message', 'code') ?? 'Not found'), events: [], raw: tr ?? raw };

    const events: TrackEvent[] = [];
    for (const e of tr.scanEvents ?? []) {
      const at = parseIsoOrMsDate(e.date);
      if (!at) continue;
      const raw = String(pick(e, 'derivedStatus', 'eventDescription') ?? '');
      const code = pick(e, 'derivedStatusCode', 'eventType');
      const loc = e.scanLocation ? [e.scanLocation.city, e.scanLocation.stateOrProvinceCode, e.scanLocation.countryCode].filter(Boolean).join(', ') : undefined;
      events.push({ status: mapStatus(Courier.FEDEX, raw, code).status, rawStatus: raw || String(code ?? ''), occurredAt: at, location: loc || undefined, note: pick(e, 'exceptionDescription') });
    }
    const latest = tr.latestStatusDetail;
    if (!events.length && latest) {
      const raw = String(pick(latest, 'statusByLocale', 'description') ?? '');
      events.push({ status: mapStatus(Courier.FEDEX, raw, pick(latest, 'derivedCode', 'code')).status, rawStatus: raw, occurredAt: new Date(), location: undefined, note: pick(latest, 'ancillaryDetails')?.[0]?.reasonDescription });
    }
    const cur = resolveCurrent(events);
    // The headline status is authoritative when present (scan lists can lag).
    const headRaw = latest ? String(pick(latest, 'statusByLocale', 'description') ?? '') : '';
    const head = latest ? mapStatus(Courier.FEDEX, headRaw, pick(latest, 'derivedCode', 'code')) : undefined;
    const status = head?.matched && head.status !== ShipmentStatus.UNKNOWN ? head.status : cur?.status ?? ShipmentStatus.UNKNOWN;
    const rawStatus = head?.matched ? headRaw : cur?.rawStatus ?? headRaw;

    const deliveredEntry = (tr.dateAndTimes ?? []).find((d: any) => d?.type === 'ACTUAL_DELIVERY');
    const deliveredAt = status === ShipmentStatus.DELIVERED ? parseIsoOrMsDate(deliveredEntry?.dateTime) ?? cur?.occurredAt : undefined;
    return { trackingNumber: tn, found: true, status, rawStatus, events, deliveredAt, receiverName: pick(tr.deliveryDetails, 'receivedByName'), raw: tr };
  }
}
