import { Injectable } from '@nestjs/common';
import { Courier, ShipmentStatus } from '@prisma/client';
import { AccountContext, TrackResult } from '../courier.types';
import { CourierError } from '../courier.errors';
import { CourierHttp, asJson } from '../http-client';
import { mapStatus } from '../status-mapper';
import { TtlCache, parseIsoOrMsDate, pick } from '../util';
import { TrackOnlyAdapter } from './track-only.base';

/**
 * Pathao Courier Merchant API (Bangladesh).
 *   Prod: https://api-hermes.pathao.com      Sandbox: https://courier-api-sandbox.pathao.com
 *   Auth: POST /aladdin/api/v1/issue-token {client_id, client_secret, username, password, grant_type:"password"}
 *         -> { access_token, refresh_token, expires_in }   (Bearer; cached until ~1 min before expiry)
 *   Info: GET /aladdin/api/v1/orders/{consignment_id}/info -> data { consignment_id, order_status, order_status_slug, updated_at, invoice_id }
 * Pathao returns only the current status here (no scan history), so events hold that single entry.
 * Endpoint paths follow Pathao's public merchant docs as mirrored by their SDKs; not yet run against a live account.
 */
@Injectable()
export class PathaoAdapter extends TrackOnlyAdapter {
  readonly courier = Courier.PATHAO;
  readonly requiredCredentials = ['clientId', 'clientSecret', 'username', 'password'];
  protected readonly label = 'Pathao';
  private tokens = new TtlCache<string>(50 * 60 * 1000);

  private base(ctx: AccountContext) {
    return ctx.credentials.baseUrl || (ctx.sandbox ? 'https://courier-api-sandbox.pathao.com' : 'https://api-hermes.pathao.com');
  }

  private async token(ctx: AccountContext, force = false): Promise<string> {
    const key = `${ctx.id}:${ctx.credentials.clientId}`;
    if (!force) {
      const c = this.tokens.get(key);
      if (c) return c;
    }
    const res = await new CourierHttp('PATHAO', this.base(ctx)).request({
      method: 'POST',
      url: '/aladdin/api/v1/issue-token',
      data: { client_id: ctx.credentials.clientId, client_secret: ctx.credentials.clientSecret, username: ctx.credentials.username, password: ctx.credentials.password, grant_type: 'password' },
    });
    const body = asJson(res.data);
    const t = pick(body, 'access_token');
    if (res.status >= 400 || !t) throw new CourierError('PATHAO', `Pathao auth failed: ${pick(body, 'message', 'error') ?? res.status}`, { httpStatus: res.status, raw: body });
    const ttl = Math.max(60, Number(pick(body, 'expires_in')) || 3600) - 60;
    this.tokens.set(key, String(t), ttl * 1000);
    return String(t);
  }

  async verifyCredentials(ctx: AccountContext): Promise<void> {
    await this.token(ctx, true);
  }

  async track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(ctx, attempt > 0);
      const res = await new CourierHttp('PATHAO', this.base(ctx), { Authorization: `Bearer ${token}`, Accept: 'application/json' }).request({
        method: 'GET',
        url: `/aladdin/api/v1/orders/${encodeURIComponent(trackingNumber)}/info`,
      });
      const body = asJson(res.data);
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw new CourierError('PATHAO', 'Unauthorized: Pathao token rejected', { httpStatus: 401, raw: body });
      if (res.status === 404 || res.status === 422) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: String(pick(body, 'message') ?? 'Not found'), events: [], raw: body };
      if (res.status >= 400) throw new CourierError('PATHAO', `Track request failed: ${pick(body, 'message') ?? res.status}`, { httpStatus: res.status, raw: body });
      const d = body?.data;
      if (!d || !(d.order_status || d.order_status_slug)) return { trackingNumber, found: false, status: ShipmentStatus.UNKNOWN, rawStatus: 'Not found', events: [], raw: body };
      const rawStatus = String(d.order_status || String(d.order_status_slug).replace(/[_-]/g, ' '));
      const status = mapStatus(Courier.PATHAO, rawStatus).status;
      const at = parseIsoOrMsDate(d.updated_at) ?? new Date();
      return { trackingNumber, found: true, status, rawStatus, events: [{ status, rawStatus, occurredAt: at }], deliveredAt: status === ShipmentStatus.DELIVERED ? at : undefined, raw: body };
    }
    throw new CourierError('PATHAO', 'Pathao auth retry exhausted');
  }
}
