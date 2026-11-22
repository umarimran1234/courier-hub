import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, TrackEvent, TrackResult } from '../courier.types';
import { CourierError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { parseCourierDate, pick } from '../util';
import { TrackOnlyAdapter } from './track-only.base';

/**
 * eCourier (Bangladesh), from the official "Merchant API Document (Reseller) v3.1" PDF.
 *   Live:    https://backoffice.ecourier.com.bd/api      Sandbox: https://staging.ecourier.com.bd/api
 *   Headers: API-KEY, API-SECRET, USER-ID
 *   Track:   POST /track   body { ecr: <eCourier ID> }  (or product_id = merchant reference)
 *            -> { response_code, message, query_data: [ { status: [ {status/description/timestamp} ], ... } ] }
 *            no match -> query_data = "No Data Found"
 * The exact key names inside each status entry are not spelled out in the PDF, so they are read tolerantly.
 * Booking (needs hub/thana/union ids) and cancel (POST /cancel-order) are not exposed yet.
 */
@Injectable()
export class EcourierAdapter extends TrackOnlyAdapter {
  readonly courier = Courier.ECOURIER;
  readonly requiredCredentials = ['apiKey', 'apiSecret', 'userId'];
  protected readonly label = 'eCourier';

  private http(ctx: AccountContext) {
    const base = ctx.credentials.baseUrl || (ctx.sandbox ? 'https://staging.ecourier.com.bd/api' : 'https://backoffice.ecourier.com.bd/api');
    return new CourierHttp('ECOURIER', base, {
      'API-KEY': String(ctx.credentials.apiKey || ''),
      'API-SECRET': String(ctx.credentials.apiSecret || ''),
      'USER-ID': String(ctx.credentials.userId || ''),
      'Content-Type': 'application/json',
    });
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    const res = await this.http(ctx).request({ method: 'POST', url: '/track', data: { ecr: 'HUBPROBE0' } });
    if (res.status === 401 || res.status === 403) throw new CourierError('ECOURIER', 'Unauthorized: invalid eCourier API key/secret/user id', { httpStatus: res.status, raw: asJson(res.data) });
    if (res.status >= 500) throw new CourierError('ECOURIER', `eCourier API error ${res.status}`, { httpStatus: res.status, retriable: true });
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const res = await this.http(ctx).request({ method: 'POST', url: '/track', data: { ecr: trackingNumber } });
    const body = asJson(res.data);
    if (res.status === 401 || res.status === 403) throw new CourierError('ECOURIER', 'Unauthorized: invalid eCourier credentials', { httpStatus: res.status, raw: body });
    if (res.status >= 400 && res.status !== 404) throw new CourierError('ECOURIER', `Track request failed: ${pick(body, 'message') ?? res.status}`, { httpStatus: res.status, raw: body });
    const q = body?.query_data;
    const row = Array.isArray(q) ? q[0] : undefined;
    if (!row) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: typeof q === 'string' ? q : 'Not found', events: [], raw: body };
    return this.parse(trackingNumber, row, body);
  }

  private parse(tn: string, row: any, raw: unknown): TrackResult {
    const list: any[] = Array.isArray(row.status) ? row.status : row.status ? [row.status] : [];
    const events: TrackEvent[] = [];
    for (const e of list) {
      const rawStatus = String(typeof e === 'string' ? e : pick(e, 'status', 'description', 'name', 'message') ?? '');
      const at = parseCourierDate(typeof e === 'string' ? undefined : pick(e, 'timestamp', 'time', 'date', 'created_at', 'datetime'));
      if (!rawStatus || !at) continue;
      events.push({ status: mapStatus(Courier.ECOURIER, rawStatus).status, rawStatus, occurredAt: at });
    }
    const cur = resolveCurrent(events);
    const status = cur?.status ?? ShipmentStatus.UNKNOWN;
    return {
      trackingNumber: tn,
      found: true,
      status,
      rawStatus: cur?.rawStatus ?? '',
      events,
      deliveredAt: status === ShipmentStatus.DELIVERED ? cur?.occurredAt : undefined,
      receiverName: pick(row, 'r_name'),
      raw,
    };
  }
}
