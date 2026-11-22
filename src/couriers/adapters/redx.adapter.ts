import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, TrackEvent, TrackResult } from '../courier.types';
import { CourierError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { parseCourierDate, pick } from '../util';
import { TrackOnlyAdapter } from './track-only.base';

/**
 * RedX (ShopUp, Bangladesh) Open API v1.0.0-beta.
 *   Base: https://openapi.redx.com.bd/v1.0.0-beta        (sandbox host is configurable via `baseUrl`)
 *   Header: API-ACCESS-TOKEN: Bearer <merchant token>   (the merchant pastes the token as shown in their RedX panel)
 *   Track:  GET /parcel/track/{tracking_id} -> { tracking: [ { message_en, message_bn, time } ] }
 * The track endpoint path and the `tracking` array shape come from the published OpenAPI + community SDKs;
 * not yet run against a live token. Parcel creation (needs a pickup_store_id) is not exposed yet.
 */
@Injectable()
export class RedxAdapter extends TrackOnlyAdapter {
  readonly courier = Courier.REDX;
  readonly requiredCredentials = ['accessToken'];
  protected readonly label = 'RedX';

  private http(ctx: AccountContext) {
    const raw = String(ctx.credentials.accessToken || '').trim();
    const token = /^bearer\s/i.test(raw) ? raw : `Bearer ${raw}`;
    return new CourierHttp('REDX', ctx.credentials.baseUrl || 'https://openapi.redx.com.bd/v1.0.0-beta', { 'API-ACCESS-TOKEN': token, 'Content-Type': 'application/json' });
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    const res = await this.http(ctx).request({ method: 'GET', url: '/pickup/stores' });
    if (res.status === 401 || res.status === 403) throw new CourierError('REDX', 'Unauthorized: invalid RedX access token', { httpStatus: res.status, raw: asJson(res.data) });
    if (res.status >= 400) throw new CourierError('REDX', `RedX API error ${res.status}`, { httpStatus: res.status, retriable: res.status >= 500, raw: asJson(res.data) });
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const res = await this.http(ctx).request({ method: 'GET', url: `/parcel/track/${encodeURIComponent(trackingNumber)}` });
    const body = asJson(res.data);
    if (res.status === 401 || res.status === 403) throw new CourierError('REDX', 'Unauthorized: invalid RedX access token', { httpStatus: res.status, raw: body });
    if (res.status === 404 || res.status === 400) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: String(pick(body, 'message', 'error') ?? 'Not found'), events: [], raw: body };
    if (res.status >= 400) throw new CourierError('REDX', `Track request failed: ${pick(body, 'message') ?? res.status}`, { httpStatus: res.status, raw: body });
    const events: TrackEvent[] = [];
    for (const e of body?.tracking ?? []) {
      const rawStatus = String(pick(e, 'message_en', 'message', 'status') ?? '');
      const at = parseCourierDate(pick(e, 'time', 'created_at', 'timestamp'));
      if (!rawStatus || !at) continue;
      events.push({ status: mapStatus(Courier.REDX, rawStatus).status, rawStatus, occurredAt: at });
    }
    if (!events.length) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'No tracking events', events, raw: body };
    const cur = resolveCurrent(events)!;
    return { trackingNumber, found: true, status: cur.status, rawStatus: cur.rawStatus, events, deliveredAt: cur.status === ShipmentStatus.DELIVERED ? cur.occurredAt : undefined, raw: body };
  }
}
