import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, TrackEvent, TrackResult } from '../courier.types';
import { CourierError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { TtlCache, pick } from '../util';
import { TrackOnlyAdapter } from './track-only.base';

/**
 * Shiprocket (India) public API.
 *   Base: https://apiv2.shiprocket.in/v1/external
 *   Auth: POST /auth/login {email, password} -> { token } (JWT, valid ~10 days; cached 23h). The merchant should use a
 *         dedicated "API user" (Settings > API > Create an API User), not their main login.
 *   Track: GET /courier/track/awb/{awb} -> tracking_data { track_status, shipment_status, shipment_track[], shipment_track_activities[] }
 *          track_status 0 = no data (tracking_data.error explains).
 * Activity timestamps are "YYYY-MM-DD HH:mm:ss" in IST. Not yet run against a live account.
 */
@Injectable()
export class ShiprocketAdapter extends TrackOnlyAdapter {
  readonly courier = Courier.SHIPROCKET;
  readonly requiredCredentials = ['email', 'password'];
  protected readonly label = 'Shiprocket';
  private tokens = new TtlCache<string>(23 * 60 * 60 * 1000);

  private base(ctx: AccountContext) {
    return ctx.credentials.baseUrl || 'https://apiv2.shiprocket.in/v1/external';
  }

  private async token(ctx: AccountContext, force = false): Promise<string> {
    const key = `${ctx.id}:${ctx.credentials.email}`;
    if (!force) {
      const c = this.tokens.get(key);
      if (c) return c;
    }
    const res = await new CourierHttp('SHIPROCKET', this.base(ctx)).request({ method: 'POST', url: '/auth/login', data: { email: ctx.credentials.email, password: ctx.credentials.password } });
    const body = asJson(res.data);
    const t = pick(body, 'token');
    if (res.status >= 400 || !t) throw new CourierError('SHIPROCKET', `Shiprocket login failed: ${pick(body, 'message') ?? res.status}`, { httpStatus: res.status, raw: body });
    this.tokens.set(key, String(t));
    return String(t);
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    await this.token(ctx, true);
  }

  private istDate(s?: string): Date | undefined {
    if (!s) return undefined;
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${String(s).trim().replace(' ', 'T')}+05:30`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(ctx, attempt > 0);
      const res = await new CourierHttp('SHIPROCKET', this.base(ctx), { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }).request({
        method: 'GET',
        url: `/courier/track/awb/${encodeURIComponent(trackingNumber)}`,
      });
      const body = asJson(res.data);
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw new CourierError('SHIPROCKET', 'Unauthorized: Shiprocket token rejected', { httpStatus: 401, raw: body });
      if (res.status >= 400 && res.status !== 404) throw new CourierError('SHIPROCKET', `Track request failed: ${pick(body, 'message') ?? res.status}`, { httpStatus: res.status, raw: body });
      const td = body?.tracking_data;
      if (res.status === 404 || !td || Number(td.track_status) === 0) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: String(pick(td, 'error') ?? pick(body, 'message') ?? 'Not found'), events: [], raw: body };
      const events: TrackEvent[] = [];
      for (const a of td.shipment_track_activities ?? []) {
        const rawStatus = String(pick(a, 'sr-status-label', 'activity', 'status') ?? '');
        const at = this.istDate(pick(a, 'date'));
        if (rawStatus && at) events.push({ status: mapStatus(Courier.SHIPROCKET, rawStatus).status, rawStatus, occurredAt: at, location: pick(a, 'location'), note: pick(a, 'activity') });
      }
      const st = td.shipment_track?.[0];
      const headRaw = String(pick(st, 'current_status') ?? '');
      const head = headRaw ? mapStatus(Courier.SHIPROCKET, headRaw) : undefined;
      const cur = resolveCurrent(events);
      const status = head?.matched && head.status !== ShipmentStatus.UNKNOWN ? head.status : cur?.status ?? ShipmentStatus.UNKNOWN;
      const deliveredAt = status === ShipmentStatus.DELIVERED ? this.istDate(pick(st, 'delivered_date')) ?? cur?.occurredAt : undefined;
      return { trackingNumber, found: true, status, rawStatus: head?.matched ? headRaw : cur?.rawStatus ?? headRaw, events, deliveredAt, receiverName: pick(st, 'delivered_to', 'consignee_name'), raw: body };
    }
    throw new CourierError('SHIPROCKET', 'Shiprocket auth retry exhausted');
  }
}
