import { Module } from '@nestjs/common';
import { PostexAdapter } from './adapters/postex.adapter';
import { LeopardsAdapter } from './adapters/leopards.adapter';
import { TcsAdapter } from './adapters/tcs.adapter';
import { FedexAdapter } from './adapters/fedex.adapter';
import { DhlAdapter } from './adapters/dhl.adapter';
import { AramexAdapter } from './adapters/aramex.adapter';
import { EcourierAdapter } from './adapters/ecourier.adapter';
import { RedxAdapter } from './adapters/redx.adapter';
import { PathaoAdapter } from './adapters/pathao.adapter';
import { BostaAdapter } from './adapters/bosta.adapter';
import { ShiprocketAdapter } from './adapters/shiprocket.adapter';
import { TranzoAdapter } from './adapters/tranzo.adapter';
import { CourierRegistry } from './courier.registry';

@Module({
  providers: [PostexAdapter, LeopardsAdapter, TcsAdapter, FedexAdapter, DhlAdapter, AramexAdapter, EcourierAdapter, RedxAdapter, PathaoAdapter, BostaAdapter, ShiprocketAdapter, TranzoAdapter, CourierRegistry],
  exports: [CourierRegistry],
})
export class CouriersModule {}
