import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, ValidateNested } from 'class-validator';
import { ApiKeyGuard } from '../auth/auth.guard';
import { TrackService } from './track.service';

class TrackItem {
  @IsString() courier: string;
  @IsString() trackingNumber: string;
}

class TrackBulkBody {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => TrackItem) items: TrackItem[];
}

/**
 * Tracking with the PLATFORM's courier credentials. No courier account has to be connected per merchant.
 * Still requires a tenant `x-api-key` so the endpoint isn't open to the internet.
 */
@Controller('v1/track')
@UseGuards(ApiKeyGuard)
export class TrackController {
  constructor(private svc: TrackService) {}

  @Get()
  couriers() {
    return this.svc.couriers();
  }

  @Post('bulk')
  bulk(@Body() dto: TrackBulkBody) {
    return this.svc.trackBulk(dto.items);
  }

  @Get(':courier/:trackingNumber')
  track(@Param('courier') courier: string, @Param('trackingNumber') tn: string) {
    return this.svc.track(courier, tn);
  }
}
