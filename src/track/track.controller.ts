import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiKeyGuard, CurrentTenant } from '../auth/auth.guard';
import { TrackService } from './track.service';

class TrackItem {
  @IsString() courier: string;
  @IsString() trackingNumber: string;
  @IsOptional() @IsString() accountId?: string;
}

class TrackBulkBody {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => TrackItem) items: TrackItem[];
}

/**
 * Stateless tracking using the calling merchant's OWN connected courier account (POST /v1/accounts).
 * Each merchant's credentials and data are isolated; nothing is stored.
 */
@Controller('v1/track')
@UseGuards(ApiKeyGuard)
export class TrackController {
  constructor(private svc: TrackService) {}

  @Get()
  connected(@CurrentTenant() t: Tenant) {
    return this.svc.connected(t);
  }

  @Post('bulk')
  bulk(@CurrentTenant() t: Tenant, @Body() dto: TrackBulkBody) {
    return this.svc.trackBulk(t, dto.items);
  }

  @Get(':courier/:trackingNumber')
  track(@CurrentTenant() t: Tenant, @Param('courier') courier: string, @Param('trackingNumber') tn: string, @Query('accountId') accountId?: string) {
    return this.svc.track(t, courier, tn, accountId);
  }
}
