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
import { CourierError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { TtlCache, chunk, normalizePkPhone, parseCourierDate, pick } from '../util';

/**
 * TCS E-COM API (per "TCS API User Guide v1.0").
 *  sandbox:    https://devconnect.tcscourier.com
 *  production: https://ociconnect.tcscourier.com
 *
 * Auth: GET /ecom/api/authentication/token  body {username,password}  -> accesstoken,
 *       then every E-COM call carries `accesstoken` in the JSON body.
 * Tracking: GET /tracking/api/Tracking/GetDynamicTrackDetail  body {consignee:[CN...]}  with Bearer token
 *       (from GET /auth/api/auth {clientId, clientsecret} when provided, else the E-COM accesstoken).
 * The guide uses GET requests that carry a JSON body — CourierHttp supports that.
 */
const SANDBOX = 'https://devconnect.tcscourier.com';
const PROD = 'https://ociconnect.tcscourier.com';
const MAX_COD = 250_000;

@Injectable()
export class TcsAdapter implements CourierAdapter {
  readonly courier = Courier.TCS;
  readonly requiredCredentials = ['username', 'password', 'accountNo', 'costCenterCode', 'shipperName', 'shipperAddress', 'shipperCity', 'shipperMobile'];
  readonly capabilities: Capabilities = {
    book: { supported: true, verified: true },
    track: { supported: true, verified: true },
    trackBulk: { supported: true, verified: true },
    cancel: { supported: true, verified: true },
    label: { supported: true, verified: true },
    cities: { supported: true, verified: true },
    webhook: { supported: false, verified: true },
    paymentStatus: { supported: true, verified: true },
    statusCatalog: { supported: true, verified: true },
  };

  private tokens = new TtlCache<string>(20 * 60 * 1000);
  private bearer = new TtlCache<string>(20 * 60 * 1000);

  private host(ctx: AccountContext) {
    return ctx.credentials.baseUrl || (ctx.sandbox ? SANDBOX : PROD);
  }
  private http(ctx: AccountContext) {
    return new CourierHttp('TCS', this.host(ctx), { 'Content-Type': 'application/json' });
  }

  /** E-COM access token (cached). */
  private async accessToken(ctx: AccountContext, force = false): Promise<string> {
    const key = `${ctx.id}:${ctx.sandbox}`;
    if (!force) {
      const c = this.tokens.get(key);
      if (c) return c;
    }
    const res = await this.http(ctx).request({ method: 'GET', url: '/ecom/api/authentication/token', data: { username: ctx.credentials.username, password: ctx.credentials.password } });
    const body = asJson(res.data);
    const token = pick(body, 'accesstoken', 'accessToken');
    if (!token) {
      throw new CourierError('TCS', `Unauthorized: ${pick(body, 'message') ?? 'could not obtain access token (check username/password)'}`, { httpStatus: res.status, raw: body });
    }
    this.tokens.set(key, String(token));
    return String(token);
  }

  /** Bearer for the tracking API. */
  private async bearerToken(ctx: AccountContext): Promise<string> {
    const { clientId, clientSecret } = ctx.credentials;
    if (!clientId || !clientSecret) return this.accessToken(ctx);
    const key = `${ctx.id}:${ctx.sandbox}:b`;
    const c = this.bearer.get(key);
    if (c) return c;
    const res = await this.http(ctx).request({ method: 'GET', url: '/auth/api/auth', data: { clientId: Number(clientId), clientsecret: clientSecret } });
    const body = asJson(res.data);
    const t = pick(body?.result, 'accessToken', 'accesstoken');
    if (!t) throw new CourierError('TCS', 'Unauthorized: invalid clientId/clientSecret for tracking API', { raw: body });
    this.bearer.set(key, String(t));
    return String(t);
  }

  /** E-COM call with the accesstoken in the body; re-authenticates once on 401. */
  private async ecom(ctx: AccountContext, method: 'GET' | 'POST', url: string, data: Record<string, any>, opts: { retries?: number; responseType?: 'json' | 'arraybuffer' } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(ctx, attempt > 0);
      const res = await this.http(ctx).request({ method, url, data: { ...data, accesstoken: token } }, opts);
      const body = opts.responseType === 'arraybuffer' ? null : asJson(res.data);
      const unauthorized = res.status === 401 || String(pick(body, 'code')) === '401';
      if (unauthorized && attempt === 0) continue;
      if (unauthorized) throw new CourierError('TCS', `Unauthorized: ${pick(body, 'message') ?? 'token rejected'}`, { httpStatus: 401, raw: body });
      return { res, body };
    }
    throw new CourierError('TCS', 'Authentication failed');
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    await this.accessToken(ctx, true);
  }

  async book(ctx: AccountContext, input: BookingInput): Promise<BookingResult> {
    const c = ctx.credentials;
    if (input.codAmount > MAX_COD) throw new CourierError('TCS', `COD amount ${input.codAmount} exceeds the TCS maximum of ${MAX_COD}`, { retriable: false });
    const parts = input.consignee.name.trim().split(/\s+/);
    const first = parts[0] || 'Customer';
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    const middle = parts.length > 2 ? parts.slice(1, -1).join(' ') : '-';
    const weight = Math.max(0.5, input.weightKg);

    const payload = {
      shipperinfo: {
        tcsaccount: String(c.accountNo),
        shippername: c.shipperName,
        address1: c.shipperAddress,
        countrycode: 'PK',
        countryname: 'Pakistan',
        cityname: c.shipperCity,
        mobile: normalizePkPhone(String(c.shipperMobile)),
      },
      consigneeinfo: {
        firstname: first,
        middlename: middle,
        lastname: last,
        address1: input.consignee.address,
        countrycode: 'PK',
        countryname: 'Pakistan',
        cityname: input.consignee.city,
        email: input.consignee.email || '',
        mobile: normalizePkPhone(input.consignee.phone),
      },
      shipmentinfo: {
        costcentercode: c.costCenterCode,
        referenceno: input.orderRef,
        contentdesc: (input.itemsDescription || `Order ${input.orderRef}`).slice(0, 50),
        servicecode: input.serviceCode || c.serviceCode || 'O',
        shipmentdate: formatTcsDate(new Date()),
        currency: 'PKR',
        codamount: Math.round(input.codAmount),
        declaredvalue: Math.round(input.codAmount),
        weightinkg: weight,
        pieces: input.pieces,
        remarks: (input.remarks || '').slice(0, 500),
        fragile: !!input.fragile,
        skus: [
          {
            description: (input.itemsDescription || `Order ${input.orderRef}`).slice(0, 200).padEnd(3, '-'),
            quantity: Math.max(1, input.pieces),
            weight,
            unitprice: Math.max(1, Math.round(input.codAmount)),
          },
        ],
      },
    };

    const { res, body } = await this.ecom(ctx, 'POST', '/ecom/api/booking/create', payload, { retries: 0 });
    const cn = pick(body, 'consignmentNo', 'consignmentno');
    const okResp = String(pick(body, 'response') ?? '').toUpperCase() === 'SUCCESS' || String(pick(body, 'code')) === '200';
    if (!cn || !okResp) {
      const errs = Array.isArray(body?.error) ? body.error.map((e: any) => pick(e, 'errorname', 'message')).join('; ') : '';
      throw new CourierError('TCS', `Create booking failed: ${errs || pick(body, 'message') || `HTTP ${res.status}`}`, { raw: body, httpStatus: res.status });
    }
    return { trackingNumber: String(cn), raw: body };
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const [r] = await this.trackMany(ctx, [trackingNumber]);
    return r;
  }

  async trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]> {
    const out: TrackResult[] = [];
    for (const group of chunk(trackingNumbers, 20)) {
      const bearer = await this.bearerToken(ctx);
      const res = await this.http(ctx).request({
        method: 'GET',
        url: '/tracking/api/Tracking/GetDynamicTrackDetail',
        data: { consignee: group },
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const body = asJson(res.data);
      if (res.status === 401 || res.status === 403) throw new CourierError('TCS', 'Unauthorized for tracking API (check clientId/clientSecret or credentials)', { httpStatus: res.status, raw: body });
      for (const tn of group) out.push(this.parseTracking(tn, body, group.length));
    }
    return out;
  }

  async cancel(ctx: AccountContext, trackingNumber: string) {
    const { res, body } = await this.ecom(ctx, 'POST', '/ecom/api/booking/cancel', { ConsignmentNumber: Number(trackingNumber) }, { retries: 0 });
    const msg = String(pick(body, 'message') ?? '');
    const ok = res.status < 300 && !/fail|not|invalid|error|cannot/i.test(msg);
    if (!ok) throw new CourierError('TCS', `Cancel failed: ${msg || `HTTP ${res.status}`}`, { raw: body });
    return { ok: true, message: msg, raw: body };
  }

  async getLabel(ctx: AccountContext, trackingNumber: string) {
    const { res } = await this.ecom(ctx, 'GET', '/ecom/api/print/label', { consignmentno: trackingNumber, shipperdetail: 'true' }, { responseType: 'arraybuffer' });
    const ct = String(res.headers?.['content-type'] ?? '');
    if (!/pdf|octet/i.test(ct)) {
      const text = Buffer.from(res.data as any).toString('utf8').slice(0, 300);
      throw new CourierError('TCS', `Label not available: ${text}`, { httpStatus: res.status });
    }
    return { contentType: 'application/pdf', data: Buffer.from(res.data as any) };
  }

  async getCities(ctx: AccountContext): Promise<CityInfo[]> {
    const { body } = await this.ecom(ctx, 'GET', '/ecom/api/setup/citylistbycountry', { countrycode: ['PK'] });
    const list: any[] = Array.isArray(body?.data) ? body.data : [];
    return list.map((c) => ({ id: String(pick(c, 'citycode') ?? ''), name: String(pick(c, 'cityname') ?? '') })).filter((c) => c.name);
  }

  async getPaymentStatus(ctx: AccountContext, trackingNumber: string) {
    const { body } = await this.ecom(ctx, 'GET', '/ecom/api/Payment/status', { customerno: Number(ctx.credentials.accountNo), consignmentno: Number(trackingNumber) });
    return body;
  }

  async getStatusCatalog(ctx: AccountContext) {
    const { body } = await this.ecom(ctx, 'GET', '/ecom/setup/deliverystatuslist', {});
    return body;
  }

  // ---------------------------------------------------------------- parsing

  private parseTracking(trackingNumber: string, body: any, batchSize: number): TrackResult {
    const norm = (v: any) => String(v ?? '').replace(/\s/g, '');
    const mine = (row: any) => !batchSize || batchSize === 1 || !pick(row, 'consignmentno') || norm(pick(row, 'consignmentno')) === norm(trackingNumber);

    const shipment = (Array.isArray(body?.shipmentinfo) ? body.shipmentinfo : []).filter(mine);
    const checkpoints = (Array.isArray(body?.checkpoints) ? body.checkpoints : []).filter(mine);
    const delivery = (Array.isArray(body?.deliveryinfo) ? body.deliveryinfo : []).filter(mine);

    const summary = String(body?.shipmentsummary ?? '');
    if ((!shipment.length && !checkpoints.length && !delivery.length) || /no data|invalid cn/i.test(summary)) {
      return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'NOT_FOUND', events: [], raw: body };
    }

    const events: TrackEvent[] = [];
    checkpoints.forEach((c: any, i: number) => {
      const rawStatus = String(pick(c, 'status') ?? '');
      events.push({
        status: mapStatus(Courier.TCS, rawStatus).status,
        rawStatus,
        occurredAt: parseCourierDate(pick(c, 'datetime')) ?? new Date(i),
        note: pick(c, 'recievedby') ? `Received by ${pick(c, 'recievedby')}` : undefined,
      });
    });
    delivery.forEach((d: any, i: number) => {
      const rawStatus = String(pick(d, 'status') ?? '');
      const code = pick(d, 'code');
      events.push({
        status: mapStatus(Courier.TCS, rawStatus, code).status,
        rawStatus: rawStatus + (code ? ` [${code}]` : ''),
        occurredAt: parseCourierDate(pick(d, 'datetime')) ?? new Date(1000 + i),
        location: pick(d, 'station'),
        note: pick(d, 'recievedby') ? `Received by ${pick(d, 'recievedby')}` : undefined,
      });
    });

    const cur = resolveCurrent(events);
    const delivered = events.filter((e) => e.status === ShipmentStatus.DELIVERED).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).pop();
    const receiver = delivery.map((d: any) => pick(d, 'recievedby')).filter(Boolean).pop();
    return {
      trackingNumber,
      found: true,
      status: cur?.status ?? ShipmentStatus.UNKNOWN,
      rawStatus: cur?.rawStatus ?? '',
      events,
      deliveredAt: cur?.status === ShipmentStatus.DELIVERED ? delivered?.occurredAt : undefined,
      receiverName: receiver,
      raw: body,
    };
  }
}

function formatTcsDate(d: Date): string {
  // Guide sample format: DD/MM/YYYY HH:MM:SS (PKT)
  const pkt = new Date(d.getTime() + 5 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(pkt.getUTCDate())}/${p(pkt.getUTCMonth() + 1)}/${pkt.getUTCFullYear()} ${p(pkt.getUTCHours())}:${p(pkt.getUTCMinutes())}:${p(pkt.getUTCSeconds())}`;
}
