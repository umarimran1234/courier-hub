import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, TrackEvent, TrackResult } from '../courier.types';
import { CourierError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { parseIsoOrMsDate, pick } from '../util';
import { TrackOnlyAdapter } from './track-only.base';

/**
 * Tranzo (Pakistan), from the partial "Integration APIs" sheet (host name was redacted in the copy we could read):
 *   Header: api-token: <merchant token>
 *   Track:  GET {base}/api/custom/v1/track-order/   query tracking_numbers=["T000..."]
 *           entries carry order_status_code, order_status, order_status_message, status_date_time
 * The API host is therefore a required credential (`baseUrl`, supplied by Tranzo with the token) until it is confirmed.
 * The response envelope is unknown, so order entries are located by searching the JSON for objects with `order_status`.
 * Not yet run against a live token.
 */
@Injectable()
export class TranzoAdapter extends TrackOnlyAdapter {
  readonly courier = Courier.TRANZO;
  readonly requiredCredentials = ['apiToken', 'baseUrl'];
  protected readonly label = 'Tranzo';

  private http(ctx: AccountContext) {
    const base = String(ctx.credentials.baseUrl || '').replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) throw new CourierError('TRANZO', 'Tranzo needs the API base URL (https://...) provided with your token', { retriable: false });
    return new CourierHttp('TRANZO', base, { 'api-token': String(ctx.credentials.apiToken || ''), 'Content-Type': 'application/json' });
  }

  private call(ctx: AccountContext, tn: string) {
    return this.http(ctx).request({ method: 'GET', url: '/api/custom/v1/track-order/', params: { tracking_numbers: JSON.stringify([tn]) } });
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    const res = await this.call(ctx, 'HUBPROBE0');
    if (res.status === 401 || res.status === 403) throw new CourierError('TRANZO', 'Unauthorized: invalid Tranzo api-token', { httpStatus: res.status, raw: asJson(res.data) });
    if (res.status >= 500) throw new CourierError('TRANZO', `Tranzo API error ${res.status}`, { httpStatus: res.status, retriable: true });
  }

  /** Depth-first collect of every object carrying `order_status`. */
  private statusObjects(node: any, out: any[] = []): any[] {
    if (Array.isArray(node)) node.forEach((n) => this.statusObjects(n, out));
    else if (node && typeof node === 'object') {
      if (node.order_status !== undefined || node.order_status_code !== undefined) out.push(node);
      Object.values(node).forEach((v) => (v && typeof v === 'object' ? this.statusObjects(v, out) : undefined));
    }
    return out;
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const res = await this.call(ctx, trackingNumber);
    const body = asJson(res.data);
    if (res.status === 401 || res.status === 403) throw new CourierError('TRANZO', 'Unauthorized: invalid Tranzo api-token', { httpStatus: res.status, raw: body });
    if (res.status === 404) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'Not found', events: [], raw: body };
    if (res.status >= 400) throw new CourierError('TRANZO', `Track request failed: ${pick(body, 'message', 'detail') ?? res.status}`, { httpStatus: res.status, raw: body });
    const events: TrackEvent[] = [];
    const seen = new Set<string>();
    for (const o of this.statusObjects(body)) {
      const rawStatus = String(pick(o, 'order_status', 'order_status_message') ?? '');
      const at = parseIsoOrMsDate(pick(o, 'status_date_time', 'status_date_time'));
      const code = pick(o, 'order_status_code');
      const k = `${code}|${rawStatus}|${at?.getTime()}`;
      if (!rawStatus || !at || seen.has(k)) continue;
      seen.add(k);
      events.push({ status: mapStatus(Courier.TRANZO, rawStatus, code != null ? String(code) : undefined).status, rawStatus, occurredAt: at, note: pick(o, 'order_status_message') });
    }
    if (!events.length) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'Not found', events, raw: body };
    const cur = resolveCurrent(events)!;
    return { trackingNumber, found: true, status: cur.status, rawStatus: cur.rawStatus, events, deliveredAt: cur.status === ShipmentStatus.DELIVERED ? cur.occurredAt : undefined, raw: body };
  }
}
