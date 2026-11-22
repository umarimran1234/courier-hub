import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Courier, Tenant } from '@prisma/client';
import { CourierRegistry } from '../couriers/courier.registry';
import { TERMINAL_STATUSES } from '../couriers/courier.types';
import { TtlCache } from '../couriers/util';
import { ShipmentsService } from '../shipments/shipments.service';
import { AccountsService } from '../accounts/accounts.service';

const TN_RE = /^[A-Za-z0-9][A-Za-z0-9\-_.]{3,39}$/;

/**
 * Stateless "give me the status of this courier ID" service, run with the CALLING MERCHANT's own connected
 * courier account (POST /v1/accounts). Nothing is stored. Cache keys include the merchant + account, so one
 * merchant's lookups/credentials never leak into another's. Results are cached briefly (long for final states).
 */
@Injectable()
export class TrackService {
  private cache: TtlCache<any>;
  private ttlMs: number;
  private finalTtlMs = 60 * 60 * 1000;

  constructor(
    private registry: CourierRegistry,
    private accounts: AccountsService,
    private shipments: ShipmentsService,
    cfg: ConfigService,
  ) {
    this.ttlMs = Math.max(0, Number(cfg.get('TRACK_CACHE_SECONDS') ?? 60)) * 1000;
    this.cache = new TtlCache<any>(this.ttlMs);
  }

  private clean(tn: string): string {
    const t = (tn ?? '').toString().trim();
    if (!TN_RE.test(t)) throw new BadRequestException(`Invalid tracking number "${tn}"`);
    return t;
  }

  private key(tenantId: string, accountId: string, tn: string) {
    return `${tenantId}:${accountId}:${tn}`;
  }

  private remember(key: string, view: any) {
    if (!view.found || this.ttlMs === 0) return;
    const final = TERMINAL_STATUSES.includes(view.status);
    this.cache.set(key, view, final ? this.finalTtlMs : this.ttlMs);
  }

  /** Which couriers this merchant has connected. */
  async connected(tenant: Tenant) {
    const rows = await this.accounts.list(tenant.id);
    return { connected: rows.filter((r) => r.active).map((r) => ({ accountId: r.id, courier: r.courier, label: r.label })) };
  }

  async track(tenant: Tenant, courierInput: string, trackingNumber: string, accountId?: string) {
    const courier = this.registry.parse(courierInput);
    const tn = this.clean(trackingNumber);
    const acc = await this.accounts.resolve(tenant.id, courier, accountId);
    const key = this.key(tenant.id, acc.id, tn);
    const hit = this.cache.get(key);
    if (hit) return { courier, cached: true, ...hit };

    const r = await this.registry.get(courier).track(this.accounts.toContext(acc), tn);
    const view = this.shipments.liveView(r);
    this.remember(key, view);
    return { courier, cached: false, ...view };
  }

  async trackBulk(tenant: Tenant, items: { courier: string; trackingNumber: string; accountId?: string }[]) {
    const out: any[] = new Array(items.length);
    const groups = new Map<string, { courier: Courier; accountId?: string; list: { idx: number; tn: string }[] }>();

    items.forEach((it, idx) => {
      try {
        const courier = this.registry.parse(it.courier);
        const tn = this.clean(it.trackingNumber);
        const gk = `${courier}:${it.accountId ?? ''}`;
        if (!groups.has(gk)) groups.set(gk, { courier, accountId: it.accountId, list: [] });
        groups.get(gk)!.list.push({ idx, tn });
      } catch (e) {
        out[idx] = { courier: it.courier, trackingNumber: it.trackingNumber, error: (e as Error).message };
      }
    });

    for (const g of groups.values()) {
      try {
        const acc = await this.accounts.resolve(tenant.id, g.courier, g.accountId);
        const pending: { idx: number; tn: string }[] = [];
        for (const l of g.list) {
          const hit = this.cache.get(this.key(tenant.id, acc.id, l.tn));
          if (hit) out[l.idx] = { courier: g.courier, cached: true, ...hit };
          else pending.push(l);
        }
        if (!pending.length) continue;
        const unique = [...new Set(pending.map((l) => l.tn))];
        const results = await this.registry.get(g.courier).trackMany(this.accounts.toContext(acc), unique);
        const byTn = new Map(results.map((r) => [r.trackingNumber, this.shipments.liveView(r)]));
        for (const l of pending) {
          const view = byTn.get(l.tn)!;
          this.remember(this.key(tenant.id, acc.id, l.tn), view);
          out[l.idx] = { courier: g.courier, cached: false, ...view };
        }
      } catch (e) {
        for (const l of g.list) if (!out[l.idx]) out[l.idx] = { courier: g.courier, trackingNumber: l.tn, error: (e as Error).message };
      }
    }
    return { results: out };
  }
}
