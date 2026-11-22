import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, TrackEvent, TrackResult } from '../courier.types';
import { CourierError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus, resolveCurrent } from '../status-mapper';
import { parseIsoOrMsDate, pick } from '../util';
import { TrackOnlyAdapter } from './track-only.base';

/**
 * Bosta (Egypt / KSA) Business API v2.
 *   Prod: https://app.bosta.co      Staging: https://stg-app.bosta.co
 *   Auth: header `Authorization: <API key>` (no "Bearer"); key created under Settings > API Integration.
 *   Track: GET /api/v2/deliveries/business/{trackingNumber} -> delivery object with state { code, value } and optional timeline.
 * Shape per Bosta's SDKs/docs; not yet run against a live key. Create/terminate/AWB are not exposed yet.
 */
@Injectable()
export class BostaAdapter extends TrackOnlyAdapter {
  readonly courier = Courier.BOSTA;
  readonly requiredCredentials = ['apiKey'];
  protected readonly label = 'Bosta';

  private http(ctx: AccountContext) {
    const base = ctx.credentials.baseUrl || (ctx.sandbox ? 'https://stg-app.bosta.co' : 'https://app.bosta.co');
    return new CourierHttp('BOSTA', base, { Authorization: String(ctx.credentials.apiKey || ''), 'Content-Type': 'application/json' });
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    const res = await this.http(ctx).request({ method: 'GET', url: '/api/v2/deliveries', params: { pageId: 1, pageLimit: 1 } });
    if (res.status === 401 || res.status === 403) throw new CourierError('BOSTA', 'Unauthorized: invalid Bosta API key', { httpStatus: res.status, raw: asJson(res.data) });
    if (res.status >= 400) throw new CourierError('BOSTA', `Bosta API error ${res.status}`, { httpStatus: res.status, retriable: res.status >= 500, raw: asJson(res.data) });
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    const res = await this.http(ctx).request({ method: 'GET', url: `/api/v2/deliveries/business/${encodeURIComponent(trackingNumber)}` });
    const body = asJson(res.data);
    if (res.status === 401 || res.status === 403) throw new CourierError('BOSTA', 'Unauthorized: invalid Bosta API key', { httpStatus: res.status, raw: body });
    if (res.status === 404) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'Not found', events: [], raw: body };
    if (res.status >= 400) throw new CourierError('BOSTA', `Track request failed: ${pick(body, 'message') ?? res.status}`, { httpStatus: res.status, raw: body });
    const d = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
    const state = d?.state;
    const headRaw = String(pick(state, 'value', 'name') ?? (typeof state === 'string' ? state : '') ?? '');
    if (!headRaw && !(d?.timeline ?? []).length) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'Not found', events: [], raw: body };
    const events: TrackEvent[] = [];
    for (const e of d?.timeline ?? []) {
      const rawStatus = String(pick(e, 'value', 'state', 'status') ?? '');
      const at = parseIsoOrMsDate(pick(e, 'date', 'time', 'updatedAt'));
      if (rawStatus && at) events.push({ status: mapStatus(Courier.BOSTA, rawStatus).status, rawStatus, occurredAt: at });
    }
    const head = mapStatus(Courier.BOSTA, headRaw);
    const headAt = parseIsoOrMsDate(pick(d, 'updatedAt', 'lastModified')) ?? new Date();
    if (!events.length && headRaw) events.push({ status: head.status, rawStatus: headRaw, occurredAt: headAt });
    const cur = resolveCurrent(events);
    const status = head.matched && head.status !== ShipmentStatus.UNKNOWN ? head.status : cur?.status ?? ShipmentStatus.UNKNOWN;
    return { trackingNumber, found: true, status, rawStatus: head.matched ? headRaw : cur?.rawStatus ?? headRaw, events, deliveredAt: status === ShipmentStatus.DELIVERED ? cur?.occurredAt ?? headAt : undefined, receiverName: pick(d?.receiver, 'fullName', 'firstName'), raw: body };
  }
}
