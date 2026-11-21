import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Courier } from '@prisma/client';
import { CourierRegistry } from '../couriers/courier.registry';
import { TERMINAL_STATUSES } from '../couriers/courier.types';
import { TtlCache } from '../couriers/util';
import { ShipmentsService } from '../shipments/shipments.service';
import { PlatformAccountsService } from './platform-accounts.service';

const TN_RE = /^[A-Za-z0-9][A-Za-z0-9\-_.]{3,39}$/;

/**
 * Stateless "give me the status of this courier ID" service.
 * Uses the platform's own courier credentials; nothing is stored, merchants connect nothing.
 * Results are cached briefly (long for final states) to protect the courier APIs and your rate limits.
 */
@Injectable()
export class TrackService {
  private cache: TtlCache<any>;
  private ttlMs: number;
  private finalTtlMs = 60 * 60 * 1000;

  constructor(
    private registry: CourierRegistry,
    private platform: PlatformAccountsService,
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

  private remember(courier: Courier, tn: string, view: any) {
    if (!view.found || this.ttlMs === 0) return;
    const final = TERMINAL_STATUSES.includes(view.status);
    this.cache.set(`${courier}:${tn}`, view, final ? this.finalTtlMs : this.ttlMs);
  }

  couriers() {
    return { configured: this.platform.configured() };
  }

  async track(courierInput: string, trackingNumber: string) {
    const courier = this.registry.parse(courierInput);
    const tn = this.clean(trackingNumber);
    const hit = this.cache.get(`${courier}:${tn}`);
    if (hit) return { courier, cached: true, ...hit };

    const r = await this.registry.get(courier).track(this.platform.get(courier), tn);
    const view = this.shipments.liveView(r);
    this.remember(courier, tn, view);
    return { courier, cached: false, ...view };
  }

  async trackBulk(items: { courier: string; trackingNumber: string }[]) {
    const out: any[] = new Array(items.length);
    const groups = new Map<Courier, { idx: number; tn: string }[]>();

    items.forEach((it, idx) => {
      try {
        const courier = this.registry.parse(it.courier);
        const tn = this.clean(it.trackingNumber);
        const hit = this.cache.get(`${courier}:${tn}`);
        if (hit) {
          out[idx] = { courier, cached: true, ...hit };
          return;
        }
        if (!groups.has(courier)) groups.set(courier, []);
        groups.get(courier)!.push({ idx, tn });
      } catch (e) {
        out[idx] = { courier: it.courier, trackingNumber: it.trackingNumber, error: (e as Error).message };
      }
    });

    for (const [courier, list] of groups) {
      try {
        const unique = [...new Set(list.map((l) => l.tn))];
        const results = await this.registry.get(courier).trackMany(this.platform.get(courier), unique);
        const byTn = new Map(results.map((r) => [r.trackingNumber, this.shipments.liveView(r)]));
        for (const l of list) {
          const view = byTn.get(l.tn)!;
          this.remember(courier, l.tn, view);
          out[l.idx] = { courier, cached: false, ...view };
        }
      } catch (e) {
        for (const l of list) out[l.idx] = { courier, trackingNumber: l.tn, error: (e as Error).message };
      }
    }
    return { results: out };
  }
}
