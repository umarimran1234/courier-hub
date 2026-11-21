import { Module } from '@nestjs/common';
import { PostexAdapter } from './adapters/postex.adapter';
import { LeopardsAdapter } from './adapters/leopards.adapter';
import { TcsAdapter } from './adapters/tcs.adapter';
import { CourierRegistry } from './courier.registry';

@Module({
  providers: [PostexAdapter, LeopardsAdapter, TcsAdapter, CourierRegistry],
  exports: [CourierRegistry],
})
export class CouriersModule {}
