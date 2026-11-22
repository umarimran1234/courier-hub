import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, BookingResult, Capabilities, CityInfo, CourierAdapter, TrackEvent, TrackResult } from '../courier.types';
import { CourierError, NotSupportedError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { chunk, parseIsoOrMsDate, pick } from '../util';

/**
 * Aramex Shipments Tracking API (JSON flavour of the ShippingAPI.V2 web services).
 *   production: https://ws.aramex.net/ShippingAPI.V2/Tracking/Service_1_0.svc/json/TrackShipments
 *   sandbox:    https://ws.dev.aramex.net/shippingapi/tracking/service_1_0.svc/json/TrackShipments
 * Request: { ClientInfo:{UserName,Password,Version,AccountNumber,AccountPin,AccountEntity,AccountCountryCode},
 *            Transaction:{Reference1}, Shipments:[waybill...], GetLastTrackingUpdateOnly:false }
 * Response: { HasErrors, Notifications:[{Code,Message}], NonExistingWaybills:[...],
 *             TrackingResults:[{Key, Value:[{WaybillNumber,UpdateCode,UpdateDescription,UpdateDateTime,UpdateLocation,Comments}]}] }
 * ClientInfo fields and the TrackShipments method come from Aramex's published manual; the exact JSON path and
 * response keys have not been run against a live account. Override the host with credentials.baseUrl if Aramex gave you another.
 * Credentials come from an Aramex account (contact your Aramex representative). Tracking-only.
 */
const PROD = 'https://ws.aramex.net/ShippingAPI.V2/Tracking/Service_1_0.svc/json';
const SANDBOX = 'https://ws.dev.aramex.net/shippingapi/tracking/service_1_0.svc/json';

@Injectable()
export class AramexAdapter implements CourierAdapter {
  readonly courier = Courier.ARAMEX;
  readonly requiredCredentials = ['userName', 'password', 'accountNumber', 'accountPin', 'accountEntity', 'accountCountryCode'];
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
    return new CourierHttp('ARAMEX', ctx.credentials.baseUrl || (ctx.sandbox ? SANDBOX : PROD), { 'Content-Type': 'application/json', Accept: 'application/json' });
  }

  private clientInfo(ctx: AccountContext) {
    const c = ctx.credentials;
    return {
      UserName: c.userName,
      Password: c.password,
      Version: c.version || 'v1.0',
      AccountNumber: String(c.accountNumber),
      AccountPin: String(c.accountPin),
      AccountEntity: c.accountEntity,
      AccountCountryCode: c.accountCountryCode,
    };
  }

  private authFailure(notes: any[]): string | undefined {
    for (const n of notes ?? []) {
      const msg = String(pick(n, 'Message') ?? '');
      if (/clientinfo|invalid account|authenticat|password|username|credential|not authori/i.test(msg)) return msg;
    }
    return undefined;
  }

  private async call(ctx: AccountContext, shipments: string[]) {
    const res = await this.http(ctx).request({
      method: 'POST',
      url: '/TrackShipments',
      data: { ClientInfo: this.clientInfo(ctx), Transaction: { Reference1: '' }, Shipments: shipments, GetLastTrackingUpdateOnly: false },
    });
    const body = asJson(res.data);
    if (res.status === 401 || res.status === 403) throw new CourierError('ARAMEX', 'Unauthorized', { httpStatus: res.status, raw: body });
    if (res.status === 429) throw new CourierError('ARAMEX', 'Rate limited by Aramex', { httpStatus: 429, retriable: true, raw: body });
    if (res.status >= 500) throw new CourierError('ARAMEX', `Aramex API error ${res.status}`, { httpStatus: res.status, retriable: true, raw: body });
    const authMsg = this.authFailure(body?.Notifications);
    if (authMsg) throw new CourierError('ARAMEX', `Unauthorized: ${authMsg}`, { httpStatus: res.status, raw: body });
    if (res.status >= 400) throw new CourierError('ARAMEX', `Track request failed (${res.status})`, { httpStatus: res.status, raw: body });
    return body;
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    // An unknown waybill is fine; an invalid ClientInfo is reported in Notifications.
    await this.call(ctx, ['0000000000']);
  }

  async book(): Promise<BookingResult> {
    throw new NotSupportedError('ARAMEX', 'Booking (tracking-only integration)');
  }
  async cancel(): Promise<{ ok: boolean; message?: string; raw: unknown }> {
    throw new NotSupportedError('ARAMEX', 'Cancel');
  }
  async getLabel(): Promise<{ contentType: string; data: Buffer } | { url: string }> {
    throw new NotSupportedError('ARAMEX', 'Labels');
  }
  async getCities(): Promise<CityInfo[]> {
    throw new NotSupportedError('ARAMEX', 'City list');
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const [r] = await this.trackMany(ctx, [trackingNumber]);
    return r;
  }

  async trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]> {
    const out: TrackResult[] = [];
    for (const group of chunk(trackingNumbers, 50)) {
      const body = await this.call(ctx, group);
      const missing = new Set<string>((body?.NonExistingWaybills ?? []).map(String));
      const byKey = new Map<string, any[]>();
      for (const r of body?.TrackingResults ?? []) byKey.set(String(pick(r, 'Key')), pick(r, 'Value') ?? []);
      for (const tn of group) out.push(this.parse(tn, missing.has(tn) ? [] : byKey.get(tn) ?? [], body));
    }
    return out;
  }

  private parse(tn: string, updates: any[], raw: unknown): TrackResult {
    const events: TrackEvent[] = [];
    for (const u of updates) {
      const at = parseIsoOrMsDate(pick(u, 'UpdateDateTime'));
      if (!at) continue;
      const rawStatus = String(pick(u, 'UpdateDescription') ?? pick(u, 'UpdateCode') ?? '');
      events.push({
        status: mapStatus(Courier.ARAMEX, rawStatus).status,
        rawStatus,
        occurredAt: at,
        location: pick(u, 'UpdateLocation') || undefined,
        note: pick(u, 'Comments') || undefined,
      });
    }
    if (!events.length) return { trackingNumber: tn, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'Not found', events: [], raw };
    const cur = resolveCurrent(events)!;
    return {
      trackingNumber: tn,
      found: true,
      status: cur.status,
      rawStatus: cur.rawStatus,
      events,
      deliveredAt: cur.status === ShipmentStatus.DELIVERED ? cur.occurredAt : undefined,
      raw: updates,
    };
  }
}
