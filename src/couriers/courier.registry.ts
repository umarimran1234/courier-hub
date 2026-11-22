import { BadRequestException, Injectable } from '@nestjs/common';
import { Courier } from '@prisma/client';
import { CourierAdapter } from './courier.types';
import { PostexAdapter } from './adapters/postex.adapter';
import { LeopardsAdapter } from './adapters/leopards.adapter';
import { TcsAdapter } from './adapters/tcs.adapter';
import { FedexAdapter } from './adapters/fedex.adapter';
import { DhlAdapter } from './adapters/dhl.adapter';
import { AramexAdapter } from './adapters/aramex.adapter';

/**
 * Add a new courier = write one adapter class, add it to this constructor, and add the value to the Courier enum.
 */
@Injectable()
export class CourierRegistry {
  private readonly adapters: Map<Courier, CourierAdapter>;

  constructor(postex: PostexAdapter, leopards: LeopardsAdapter, tcs: TcsAdapter, fedex: FedexAdapter, dhl: DhlAdapter, aramex: AramexAdapter) {
    this.adapters = new Map<Courier, CourierAdapter>([postex, leopards, tcs, fedex, dhl, aramex].map((a) => [a.courier, a]));
  }

  get(courier: Courier): CourierAdapter {
    const a = this.adapters.get(courier);
    if (!a) throw new BadRequestException(`Unsupported courier: ${courier}`);
    return a;
  }

  list(): CourierAdapter[] {
    return [...this.adapters.values()];
  }

  parse(input: string): Courier {
    const c = (input || '').toUpperCase() as Courier;
    if (!this.adapters.has(c)) throw new BadRequestException(`Unsupported courier "${input}". Supported: ${[...this.adapters.keys()].join(', ')}`);
    return c;
  }
}
