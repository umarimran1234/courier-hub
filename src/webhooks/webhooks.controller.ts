import { Body, Controller, HttpCode, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { CourierRegistry } from '../couriers/courier.registry';
import { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from '../shipments/shipments.service';

/**
 * Inbound courier push updates (currently Leopards Push API).
 * Give the courier this URL:  POST https://<host>/v1/webhooks/leopards/<account.webhookToken>
 * The unguessable per-account token authenticates the call.
 * Always answers 200 for well-formed requests so the courier does not retry-storm; unknown payloads are logged.
 */
@Controller('v1/webhooks')
export class WebhooksController {
  private log = new Logger('Webhooks');

  constructor(private prisma: PrismaService, private registry: CourierRegistry, private shipments: ShipmentsService) {}

  @Post(':courier/:token')
  @HttpCode(200)
  async receive(@Param('courier') courierParam: string, @Param('token') token: string, @Body() body: any) {
    const courier = this.registry.parse(courierParam);
    const account = await this.prisma.courierAccount.findUnique({ where: { webhookToken: token } });
    if (!account || account.courier !== courier) throw new NotFoundException();

    const adapter = this.registry.get(courier);
    if (!adapter.parseWebhook) return { ok: true, ignored: 'courier has no webhook support' };

    const items: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [body];
    let applied = 0;
    for (const item of items) {
      const ev = adapter.parseWebhook(item);
      if (!ev) {
        this.log.warn(`${courier} webhook payload not understood: ${JSON.stringify(item).slice(0, 300)}`);
        continue;
      }
      const shipment = await this.prisma.shipment.findFirst({ where: { tenantId: account.tenantId, courier, trackingNumber: ev.trackingNumber } });
      if (!shipment) continue;
      await this.shipments.applyWebhookEvent(shipment, ev);
      applied++;
    }
    return { ok: true, applied };
  }
}
