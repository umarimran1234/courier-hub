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
import { TtlCache, chunk, matchCity, normalizePkPhone, parseCourierDate, pick } from '../util';

/**
 * Leopards (LCS) Merchant API.
 *  prod:    https://merchantapi.leopardscourier.com/api/
 *  staging: https://merchantapistaging.leopardscourier.com/api/
 * Auth: api_key + api_password sent with every request (query for GET, form for POST).
 *
 * book / track / cities are confirmed from the open-source client; cancel and the Push (webhook)
 * payload are NOT publicly documented -> marked verified:false.
 */
const PROD = 'https://merchantapi.leopardscourier.com/api/';
const STAGING = 'https://merchantapistaging.leopardscourier.com/api/';

interface LcsCity extends CityInfo {
  id: string;
}

@Injectable()
export class LeopardsAdapter implements CourierAdapter {
  readonly courier = Courier.LEOPARDS;
  readonly requiredCredentials = ['apiKey', 'apiPassword'];
  readonly capabilities: Capabilities = {
    book: { supported: true, verified: true },
    track: { supported: true, verified: true },
    trackBulk: { supported: true, verified: true },
    cancel: { supported: true, verified: false },
    label: { supported: true, verified: true }, // slip_link returned at booking time
    cities: { supported: true, verified: true },
    webhook: { supported: true, verified: false },
    paymentStatus: { supported: false, verified: true },
    statusCatalog: { supported: false, verified: true },
  };

  private cityCache = new TtlCache<LcsCity[]>(6 * 60 * 60 * 1000);

  private http(ctx: AccountContext) {
    return new CourierHttp('LEOPARDS', ctx.credentials.baseUrl || (ctx.sandbox ? STAGING : PROD));
  }

  private auth(ctx: AccountContext) {
    return { api_key: ctx.credentials.apiKey, api_password: ctx.credentials.apiPassword };
  }

  private ensureOk(body: any, what: string) {
    if (typeof body === 'string') throw new CourierError('LEOPARDS', `${what}: unexpected response (${body.slice(0, 120)})`, { raw: body });
    const st = pick(body, 'status');
    const ok = st === 1 || st === '1' || st === true;
    if (!ok) {
      const err = pick(body, 'error', 'message');
      throw new CourierError('LEOPARDS', `${what} failed: ${typeof err === 'string' ? err : JSON.stringify(err ?? body)}`, { raw: body });
    }
    return body;
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    await this.getCities(ctx, true);
  }

  async getCities(ctx: AccountContext, force = false): Promise<LcsCity[]> {
    const key = `${ctx.id}:${ctx.sandbox}`;
    if (!force) {
      const c = this.cityCache.get(key);
      if (c) return c;
    }
    const res = await this.http(ctx).request({ method: 'GET', url: 'getAllCities/format/json/', params: this.auth(ctx) });
    const body = this.ensureOk(asJson(res.data), 'Get cities');
    const list: any[] = Array.isArray(body.city_list) ? body.city_list : [];
    const cities: LcsCity[] = list
      .map((c) => ({ id: String(pick(c, 'id', 'city_id')), name: String(pick(c, 'name', 'city_name') ?? ''), extra: c }))
      .filter((c) => c.id && c.name);
    this.cityCache.set(key, cities);
    return cities;
  }

  private async resolveCity(ctx: AccountContext, name: string): Promise<LcsCity> {
    if (/^\d+$/.test(name.trim())) return { id: name.trim(), name };
    const cities = await this.getCities(ctx);
    const hit = matchCity(cities, name);
    if (!hit) {
      const sample = cities.filter((c) => c.name.toLowerCase().startsWith(name.trim().toLowerCase().slice(0, 2))).slice(0, 5).map((c) => c.name);
      throw new CourierError('LEOPARDS', `Unknown destination city "${name}"${sample.length ? `. Did you mean: ${sample.join(', ')}?` : ''}`, { retriable: false });
    }
    return hit;
  }

  async book(ctx: AccountContext, input: BookingInput): Promise<BookingResult> {
    const dest = await this.resolveCity(ctx, input.consignee.city);
    const origin = ctx.credentials.originCityId ? String(ctx.credentials.originCityId) : 'self';
    const form: Record<string, any> = {
      ...this.auth(ctx),
      booked_packet_weight: Math.round(input.weightKg * 1000), // grams
      booked_packet_no_piece: input.pieces,
      booked_packet_collect_amount: Math.round(input.codAmount),
      booked_packet_order_id: input.orderRef,
      origin_city: origin,
      destination_city: dest.id,
      // 'self' = use the shipper details registered on the Leopards account
      shipment_name_eng: ctx.credentials.shipperName || 'self',
      shipment_email: ctx.credentials.shipperEmail || 'self',
      shipment_phone: ctx.credentials.shipperPhone || 'self',
      shipment_address: ctx.credentials.shipperAddress || 'self',
      consignment_name_eng: input.consignee.name,
      consignment_email: input.consignee.email || ctx.credentials.fallbackEmail || 'noemail@example.com',
      consignment_phone: normalizePkPhone(input.consignee.phone),
      consignment_phone_two: input.consignee.phone2 ? normalizePkPhone(input.consignee.phone2) : '',
      consignment_address: input.consignee.address,
      special_instructions: input.remarks || input.itemsDescription || 'Handle with care',
      shipment_type: input.serviceCode || ctx.credentials.shipmentType || '',
    };
    const res = await this.http(ctx).request(
      { method: 'POST', url: 'bookPacket/format/json/', data: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v ?? '')])).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      { retries: 0 },
    );
    const body = this.ensureOk(asJson(res.data), 'Book packet');
    const tn = pick(body, 'track_number', 'cn_number');
    if (!tn) throw new CourierError('LEOPARDS', 'Booking succeeded but no track_number was returned', { raw: body });
    return { trackingNumber: String(tn), labelUrl: pick(body, 'slip_link') ? String(pick(body, 'slip_link')) : undefined, raw: body };
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const [r] = await this.trackMany(ctx, [trackingNumber]);
    return r;
  }

  async trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]> {
    const results: TrackResult[] = [];
    for (const group of chunk(trackingNumbers, 25)) {
      const res = await this.http(ctx).request({
        method: 'GET',
        url: 'trackBookedPacket/format/json/',
        params: { ...this.auth(ctx), track_numbers: group.join(',') },
      });
      const body = asJson(res.data);
      // Leopards answers status:0 with an error when none of the numbers are valid -> treat as not found.
      const ok = body && typeof body === 'object' && (pick(body, 'status') === 1 || pick(body, 'status') === '1');
      const list: any[] = ok ? (Array.isArray(body.packet_list) ? body.packet_list : body.packet_list ? [body.packet_list] : []) : [];
      if (!ok && !list.length) {
        const err = String(pick(body, 'error') ?? '');
        if (/auth|invalid (api|key|password)|credential/i.test(err)) throw new CourierError('LEOPARDS', `Unauthorized: ${err}`, { raw: body });
      }
      const byTn = new Map<string, any>();
      for (const p of list) {
        const tn = pick(p, 'track_number', 'cn_number', 'tracking_number');
        if (tn) byTn.set(String(tn), p);
      }
      for (const tn of group) {
        const p = byTn.get(tn);
        results.push(p ? this.parsePacket(tn, p, body) : { trackingNumber: tn, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'NOT_FOUND', events: [], raw: body });
      }
    }
    return results;
  }

  async cancel(ctx: AccountContext, trackingNumber: string) {
    // NOTE: endpoint/param names taken from Leopards' public API list; not confirmed against a live account.
    const res = await this.http(ctx).request(
      { method: 'POST', url: 'cancelBookedPackets/format/json/', data: new URLSearchParams({ ...this.auth(ctx), cn_numbers: trackingNumber } as any).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      { retries: 0 },
    );
    const body = this.ensureOk(asJson(res.data), 'Cancel packet');
    return { ok: true, message: String(pick(body, 'message') ?? 'Cancelled'), raw: body };
  }

  async getLabel(): Promise<never> {
    // The slip link is returned when booking and stored on the shipment (see ShipmentsService.getLabel).
    throw new NotSupportedError('LEOPARDS', 'Label re-generation (use the stored slip link from booking)');
  }

  /** Leopards Push API: payload shape is not public; tolerate common key names. */
  parseWebhook(p: any) {
    const tn = pick(p, 'track_number', 'tracking_number', 'cn_number', 'cn', 'consignment_no', 'consignment_number');
    const st = pick(p, 'status', 'current_status', 'packet_status', 'booked_packet_status', 'status_name');
    if (!tn || !st) return null;
    return {
      trackingNumber: String(tn),
      rawStatus: String(st),
      occurredAt: parseCourierDate(pick(p, 'datetime', 'date_time', 'date', 'activity_date'), pick(p, 'time', 'activity_time')),
      note: pick(p, 'reason', 'remarks', 'note'),
    };
  }

  // ---------------------------------------------------------------- parsing

  private parsePacket(trackingNumber: string, p: any, raw: unknown): TrackResult {
    const detail: any[] = pick(p, 'Tracking Detail', 'tracking_detail', 'TrackingDetail', 'trackingDetails') ?? [];
    const events: TrackEvent[] = (Array.isArray(detail) ? detail : []).map((d, i) => {
      const rawStatus = String(pick(d, 'Status', 'status', 'Activity', 'activity') ?? '');
      return {
        status: mapStatus(Courier.LEOPARDS, rawStatus).status,
        rawStatus,
        occurredAt: parseCourierDate(pick(d, 'Activity_Date', 'activity_date', 'date'), pick(d, 'Activity_Time', 'activity_time', 'time')) ?? new Date(i),
        location: pick(d, 'Location', 'location', 'City', 'city'),
        note: pick(d, 'Reason', 'reason', 'Remarks', 'remarks'),
      };
    });

    const headline = String(pick(p, 'booked_packet_status', 'status', 'packet_status') ?? '');
    const headMap = headline ? mapStatus(Courier.LEOPARDS, headline) : undefined;
    const cur = resolveCurrent(events);
    const status = headMap?.matched ? headMap.status : cur?.status ?? ShipmentStatus.UNKNOWN;
    const rawStatus = headline || cur?.rawStatus || '';
    const delivered = events.filter((e) => e.status === ShipmentStatus.DELIVERED).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).pop();
    const lastEv = events.find((e) => /deliver/i.test(e.rawStatus) && e.note);
    return {
      trackingNumber,
      found: true,
      status,
      rawStatus,
      events,
      deliveredAt: status === ShipmentStatus.DELIVERED ? delivered?.occurredAt : undefined,
      receiverName: pick(p, 'Reciever_Name', 'receiver_name', 'received_by') ?? lastEv?.note,
      raw,
    };
  }
}
