import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { AdminController, TenantController } from './admin/admin.controller';
import { AdminGuard, ApiKeyGuard } from './auth/auth.guard';
import { CourierErrorFilter } from './common/courier-error.filter';
import { CryptoService } from './common/crypto.service';
import { CouriersController } from './couriers/couriers.controller';
import { CouriersModule } from './couriers/couriers.module';
import { NotifyProcessor, NotifyService, NOTIFY_QUEUE } from './notify/notify.service';
import { PrismaModule } from './prisma/prisma.service';
import { ShipmentsController } from './shipments/shipments.controller';
import { ShipmentsService } from './shipments/shipments.service';
import { SyncProcessor, SyncScheduler, SYNC_QUEUE } from './sync/sync.service';
import { PlatformAccountsService } from './track/platform-accounts.service';
import { TrackController } from './track/track.controller';
import { TrackService } from './track/track.service';
import { WebhooksController } from './webhooks/webhooks.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        connection: { url: cfg.get<string>('REDIS_URL') ?? 'redis://localhost:6379', maxRetriesPerRequest: null },
      }),
    }),
    BullModule.registerQueue({ name: SYNC_QUEUE }, { name: NOTIFY_QUEUE }),
    CouriersModule,
  ],
  controllers: [AccountsController, ShipmentsController, CouriersController, AdminController, TenantController, WebhooksController, TrackController],
  providers: [
    CryptoService,
    AccountsService,
    ShipmentsService,
    NotifyService,
    PlatformAccountsService,
    TrackService,
    NotifyProcessor,
    SyncScheduler,
    SyncProcessor,
    ApiKeyGuard,
    AdminGuard,
    { provide: APP_FILTER, useClass: CourierErrorFilter },
  ],
})
export class AppModule {}
