import { Courier } from '@prisma/client';
import { AccountContext, BookingResult, Capabilities, CityInfo, TrackResult } from '../courier.types';
import { NotSupportedError } from '../courier.errors';
import { chunk } from '../util';

/** Shared plumbing for adapters that only track (no booking/cancel/labels). */
export abstract class TrackOnlyAdapter {
  abstract readonly courier: Courier;
  abstract readonly requiredCredentials: string[];
  protected abstract readonly label: string;

  /** `verified:false` everywhere until the shapes are confirmed against a live account. */
  get capabilities(): Capabilities {
    const no = { supported: false, verified: true };
    return {
      book: no,
      track: { supported: true, verified: false },
      trackBulk: { supported: true, verified: false },
      cancel: no,
      label: no,
      cities: no,
      webhook: no,
      paymentStatus: no,
      statusCatalog: no,
    };
  }

  abstract verifyCredentials(ctx: AccountContext): Promise<void>;
  abstract track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult>;

  async trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]> {
    const out: TrackResult[] = [];
    for (const group of chunk(trackingNumbers, 5)) out.push(...(await Promise.all(group.map((tn) => this.track(ctx, tn)))));
    return out;
  }

  async book(): Promise<BookingResult> {
    throw new NotSupportedError(this.label, 'Booking (tracking-only integration)');
  }
  async cancel(): Promise<{ ok: boolean; message?: string; raw: unknown }> {
    throw new NotSupportedError(this.label, 'Cancel');
  }
  async getLabel(): Promise<{ contentType: string; data: Buffer } | { url: string }> {
    throw new NotSupportedError(this.label, 'Labels');
  }
  async getCities(): Promise<CityInfo[]> {
    throw new NotSupportedError(this.label, 'City list');
  }
}
