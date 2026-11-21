import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { Response } from 'express';
import { ApiKeyGuard, CurrentTenant } from '../auth/auth.guard';
import { BookShipmentDto, ListShipmentsQuery, TrackBulkDto } from './shipments.dto';
import { ShipmentsService } from './shipments.service';

@Controller('v1/shipments')
@UseGuards(ApiKeyGuard)
export class ShipmentsController {
  constructor(private svc: ShipmentsService) {}

  /** Book a parcel with any supported courier using one unified payload. */
  @Post()
  book(@CurrentTenant() t: Tenant, @Body() dto: BookShipmentDto) {
    return this.svc.book(t, dto);
  }

  @Get()
  list(@CurrentTenant() t: Tenant, @Query() q: ListShipmentsQuery) {
    return this.svc.list(t, q);
  }

  /** Track many tracking numbers (any mix of couriers) in one call. */
  @Post('track-bulk')
  trackBulk(@CurrentTenant() t: Tenant, @Body() dto: TrackBulkDto) {
    return this.svc.trackBulk(t, dto);
  }

  /** Live track by courier + tracking number ("courier id dal kar status"). Stored shipments are updated too. */
  @Get('track/:courier/:trackingNumber')
  track(@CurrentTenant() t: Tenant, @Param('courier') courier: string, @Param('trackingNumber') tn: string, @Query('accountId') accountId?: string) {
    return this.svc.liveTrack(t, courier, tn, accountId);
  }

  @Get(':id')
  get(@CurrentTenant() t: Tenant, @Param('id') id: string) {
    return this.svc.get(t, id);
  }

  /** Force a live re-sync of this shipment from the courier. */
  @Post(':id/refresh')
  refresh(@CurrentTenant() t: Tenant, @Param('id') id: string) {
    return this.svc.refresh(t, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentTenant() t: Tenant, @Param('id') id: string) {
    return this.svc.cancel(t, id);
  }

  @Get(':id/label')
  async label(@CurrentTenant() t: Tenant, @Param('id') id: string, @Res() res: Response) {
    const l = await this.svc.getLabel(t, id);
    if ('url' in l) return res.redirect(l.url);
    res.setHeader('Content-Type', l.contentType);
    res.setHeader('Content-Disposition', `inline; filename="label-${id}.pdf"`);
    return res.send(l.data);
  }

  /** COD settlement status (PostEx and TCS). */
  @Get(':id/payment-status')
  paymentStatus(@CurrentTenant() t: Tenant, @Param('id') id: string) {
    return this.svc.paymentStatus(t, id);
  }
}
