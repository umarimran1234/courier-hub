import { Module } from '@nestjs/common';
import { PostexAdapter } from './adapters/postex.adapter';
import { LeopardsAdapter } from './adapters/leopards.adapter';
import { TcsAdapter } from './adapters/tcs.adapter';
import { FedexAdapter } from './adapters/fedex.adapter';
import { DhlAdapter } from './adapters/dhl.adapter';
import { AramexAdapter } from './adapters/aramex.adapter';
import { CourierRegistry } from './courier.registry';

@Module({
  providers: [PostexAdapter, LeopardsAdapter, TcsAdapter, FedexAdapter, DhlAdapter, AramexAdapter, CourierRegistry],
  exports: [CourierRegistry],
})
export class CouriersModule {}
